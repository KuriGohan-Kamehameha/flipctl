/*
 * Flipctl — Flipper Zero ufbt app.
 *
 * Switches the BLE profile to Serial (the same profile qFlipper / the official
 * Flipper mobile app use), registers an RX callback for the serial channel,
 * and dispatches newline-terminated commands of the form
 *   KIND[:ARG]\n
 * with replies of the form
 *   OK[:detail]\n  |  ERR:reason\n
 *
 * Phase 1 (this file): the dispatcher acknowledges any well-formed command
 * from the known subsystem prefixes (subghz./nfc./ir./badusb./system.) with a
 * stub. Phase 2 wires each handler into actual Flipper subsystem APIs
 * (subghz_worker, nfc, infrared_worker, badusb, furi_hal_*).
 *
 * Reference: maybe-hello-world/fbs (the canonical "BT Serial app" pattern,
 * pre-profile API), updated for the modern bt_profile_start /
 * ble_profile_serial_* surface.
 */

#include "flipctl.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static void status_set(Flipctl* app, const char* s) {
    strncpy(app->status, s, FLIPCTL_STATUS_LEN - 1);
    app->status[FLIPCTL_STATUS_LEN - 1] = 0;
}

static void draw_callback(Canvas* canvas, void* ctx) {
    Flipctl* app = ctx;
    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str_aligned(canvas, 64, 12, AlignCenter, AlignCenter, "Flipctl");
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, 64, 32, AlignCenter, AlignCenter, app->status);
    canvas_draw_str_aligned(canvas, 64, 56, AlignCenter, AlignCenter, "Back to exit");
}

static void input_callback(InputEvent* input, void* ctx) {
    Flipctl* app = ctx;
    furi_message_queue_put(app->input_queue, input, FuriWaitForever);
}

/*
 * BT Serial RX callback — runs on the BT thread.
 *
 * Must NOT block. Bytes go into rx_line; on '\n' we heap-copy the line and
 * post the pointer to line_queue for the main thread to dispatch.
 */
static uint16_t bt_rx_callback(SerialServiceEvent event, void* context);
static void install_callback(Flipctl* app);

// Bt service status callback: fires every time GAP state changes. The
// firmware's bt_open_rpc_connection() runs on each Connect and overrides our
// event_callback with its own RPC bridge — so we re-claim the channel here.
static void status_changed_callback(BtStatus status, void* ctx) {
    Flipctl* app = ctx;
    // Defensive: if we're tearing down and another BT event slipped through
    // before bt_set_status_changed_callback(NULL) took effect, do nothing.
    if(!app || !app->serial_profile) return;
    printf("[FLIPCTL] status=%d\n", (int)status);
    if(status == BtStatusConnected && app->serial_profile) {
        // Drop any partial line carried over from a previous link.
        app->rx_line_len = 0;
        app->rx_line_tainted = false;
        install_callback(app);
        printf("[FLIPCTL] reclaimed serial callback after BT connect; rx buffer cleared\n");
    }
}

static void install_callback(Flipctl* app) {
    // Register our event callback first so incoming bytes flow to us, then
    // disable RPC for completeness.
    ble_profile_serial_set_event_callback(
        app->serial_profile, FLIPCTL_BT_RX_BUFFER, bt_rx_callback, app);
    ble_profile_serial_set_rpc_active(app->serial_profile, false);
}

static uint16_t bt_rx_callback(SerialServiceEvent event, void* context) {
    Flipctl* app = context;
    if(event.event != SerialServiceEventTypeDataReceived) return 0;
    printf("[FLIPCTL] rx %u bytes\n", event.data.size);

    // If the previous event left us tainted (binary byte seen mid-line, no \n
    // arrived to clear it), the taint would otherwise consume the next clean
    // command's bytes. Discard the partial line at the event boundary.
    if(app->rx_line_tainted) {
        app->rx_line_len = 0;
        app->rx_line_tainted = false;
    }

    for(size_t i = 0; i < event.data.size; i++) {
        unsigned char c = event.data.buffer[i];
        if(c == '\r') continue;
        if(c == '\n') {
            // Only emit if the line is non-empty AND was never touched by a
            // non-printable byte. Protobuf RPC garbage flushed by the
            // firmware's bt_open_rpc bridge contains printable chars mixed
            // with binary; tainting the whole line on any binary byte keeps
            // those frames from leaking into our dispatcher.
            if(app->rx_line_len > 0 && !app->rx_line_tainted) {
                app->rx_line[app->rx_line_len] = 0;
                char* line = malloc(app->rx_line_len + 1);
                if(line) {
                    memcpy(line, app->rx_line, app->rx_line_len + 1);
                    if(furi_message_queue_put(app->line_queue, &line, 0) != FuriStatusOk) {
                        free(line);
                    }
                }
            }
            app->rx_line_len = 0;
            app->rx_line_tainted = false;
        } else if(c < 0x20 || c >= 0x7f) {
            // Non-printable byte — taint the line so it gets discarded at \n.
            app->rx_line_tainted = true;
        } else if(app->rx_line_len < FLIPCTL_LINE_BUFFER - 1) {
            app->rx_line[app->rx_line_len++] = (char)c;
        } else {
            // Overflow.
            app->rx_line_tainted = true;
        }
    }
    return 0;
}

static void send_reply(Flipctl* app, const char* line) {
    if(!app->serial_profile) {
        printf("[FLIPCTL] send_reply: no profile\n");
        return;
    }
    char buf[FLIPCTL_REPLY_BUFFER];
    int n = snprintf(buf, sizeof(buf), "%s\n", line);
    if(n > 0 && n < (int)sizeof(buf)) {
        bool ok = ble_profile_serial_tx(app->serial_profile, (uint8_t*)buf, (uint16_t)n);
        printf("[FLIPCTL] tx %d bytes ok=%d: %s\n", n, (int)ok, line);
    }
}

/*
 * Open the named app via the Loader.
 *
 * 1. Reply over BLE before we touch BT state.
 * 2. furi_delay_ms so the radio actually pushes the frame.
 * 3. Tear down our BT hooks (status callback + serial event callback +
 *    profile restore) BEFORE handing off — once loader_start runs, our task
 *    can be killed at any point, and any leftover callback registrations
 *    would dereference freed memory the next time BT fires.
 * 4. Then loader_start.
 */
static void launch_app(Flipctl* app, const char* name, const char* reply_msg) {
    send_reply(app, reply_msg);
    furi_delay_ms(120);
    if(app->serial_profile) {
        bt_set_status_changed_callback(app->bt, NULL, NULL);
        ble_profile_serial_set_event_callback(app->serial_profile, 0, NULL, NULL);
        bt_profile_restore_default(app->bt);
        app->serial_profile = NULL;
    }
    LoaderStatus s = loader_start_with_gui_error(app->loader, name, NULL);
    printf("[FLIPCTL] loader_start_with_gui_error('%s') -> %d\n", name, (int)s);
}

/*
 * Read /ext/favorites.txt, build "OK:line1|line2|..." into reply.
 * Truncates with "|..." if more favourites would overflow the BLE frame.
 */
static void handle_favourites_list(Flipctl* app) {
    File* file = storage_file_alloc(app->storage);
    if(!storage_file_open(file, FLIPCTL_FAV_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        storage_file_close(file);
        storage_file_free(file);
        send_reply(app, "OK:");
        return;
    }

    char buf[FLIPCTL_REPLY_BUFFER];
    int written = snprintf(buf, sizeof(buf), "OK:");
    char line[128];
    size_t line_len = 0;
    bool first = true;
    bool truncated = false;

    while(!storage_file_eof(file) && !truncated) {
        char c;
        if(storage_file_read(file, &c, 1) != 1) break;
        if(c == '\r') continue;
        if(c == '\n') {
            if(line_len > 0) {
                int sep = first ? 0 : 1;
                if(written + sep + (int)line_len + 5 < (int)sizeof(buf)) {
                    if(sep) buf[written++] = '|';
                    memcpy(buf + written, line, line_len);
                    written += line_len;
                    first = false;
                } else {
                    if(written + 4 < (int)sizeof(buf)) {
                        memcpy(buf + written, "|...", 4);
                        written += 4;
                    }
                    truncated = true;
                }
                line_len = 0;
            }
        } else if(line_len < sizeof(line) - 1) {
            line[line_len++] = c;
        }
    }
    // trailing line without newline
    if(line_len > 0 && !truncated) {
        int sep = first ? 0 : 1;
        if(written + sep + (int)line_len + 1 < (int)sizeof(buf)) {
            if(sep) buf[written++] = '|';
            memcpy(buf + written, line, line_len);
            written += line_len;
        }
    }
    storage_file_close(file);
    storage_file_free(file);

    if(written + 1 < (int)sizeof(buf)) {
        buf[written++] = '\n';
        ble_profile_serial_tx(app->serial_profile, (uint8_t*)buf, (uint16_t)written);
        printf("[FLIPCTL] tx %d bytes (favourites.list)\n", written);
    }
}

/*
 * Read the Nth (0-based) favourite from /ext/favorites.txt and launch it.
 */
static void handle_favourites_run(Flipctl* app, const char* arg) {
    if(!arg || !*arg) { send_reply(app, "ERR:missing_index"); return; }
    int target_idx = atoi(arg);
    if(target_idx < 0) { send_reply(app, "ERR:bad_index"); return; }

    File* file = storage_file_alloc(app->storage);
    if(!storage_file_open(file, FLIPCTL_FAV_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        storage_file_close(file);
        storage_file_free(file);
        send_reply(app, "ERR:no_favourites_file");
        return;
    }

    char target[128] = {0};
    char line[128];
    size_t line_len = 0;
    int idx = 0;
    bool found = false;

    while(!storage_file_eof(file) && !found) {
        char c;
        if(storage_file_read(file, &c, 1) != 1) break;
        if(c == '\r') continue;
        if(c == '\n') {
            if(line_len > 0) {
                if(idx == target_idx) {
                    line[line_len] = 0;
                    strncpy(target, line, sizeof(target) - 1);
                    found = true;
                }
                idx++;
                line_len = 0;
            }
        } else if(line_len < sizeof(line) - 1) {
            line[line_len++] = c;
        }
    }
    if(!found && line_len > 0 && idx == target_idx) {
        line[line_len] = 0;
        strncpy(target, line, sizeof(target) - 1);
        found = true;
    }
    storage_file_close(file);
    storage_file_free(file);

    if(!found) { send_reply(app, "ERR:not_found"); return; }

    char reply[FLIPCTL_REPLY_BUFFER];
    snprintf(reply, sizeof(reply), "OK:opening %s", target);
    launch_app(app, target, reply);
}

/*
 * Inject a synthesized D-pad / OK / Back press into the firmware's input
 * pubsub. The active app receives Press → Short → Release as if a hardware
 * button was tapped. Sequence source = SOFTWARE so subscribers can tell.
 */
static void send_input(Flipctl* app, InputKey key) {
    if(!app->input_events) return;
    InputEvent ev = {0};
    ev.sequence_source = INPUT_SEQUENCE_SOURCE_SOFTWARE;
    ev.sequence_counter = ++app->input_seq;
    ev.key = key;

    ev.type = InputTypePress;
    furi_pubsub_publish(app->input_events, &ev);
    furi_delay_ms(30);

    ev.type = InputTypeShort;
    furi_pubsub_publish(app->input_events, &ev);
    furi_delay_ms(10);

    ev.type = InputTypeRelease;
    furi_pubsub_publish(app->input_events, &ev);
}

static void send_input_long(Flipctl* app, InputKey key) {
    if(!app->input_events) return;
    InputEvent ev = {0};
    ev.sequence_source = INPUT_SEQUENCE_SOURCE_SOFTWARE;
    ev.sequence_counter = ++app->input_seq;
    ev.key = key;

    ev.type = InputTypePress;
    furi_pubsub_publish(app->input_events, &ev);
    furi_delay_ms(30);

    ev.type = InputTypeLong;
    furi_pubsub_publish(app->input_events, &ev);
    furi_delay_ms(10);

    ev.type = InputTypeRelease;
    furi_pubsub_publish(app->input_events, &ev);
}

/*
 * Parse "KIND[:ARG]" line and dispatch.
 */
static void dispatch_line(Flipctl* app, char* line) {
    char* colon = strchr(line, ':');
    const char* kind = line;
    const char* arg = NULL;
    if(colon) {
        *colon = 0;
        arg = colon + 1;
    }

    char status_line[FLIPCTL_STATUS_LEN];
    snprintf(
        status_line,
        sizeof(status_line),
        "%s%s%s",
        kind,
        arg && *arg ? ":" : "",
        arg && *arg ? arg : "");
    status_set(app, status_line);

    // Mirroring: synthesize button presses for the active Flipper app.
    if(strcmp(kind, "input.up") == 0)    { send_input(app, InputKeyUp);    send_reply(app, "OK:up");    return; }
    if(strcmp(kind, "input.down") == 0)  { send_input(app, InputKeyDown);  send_reply(app, "OK:down");  return; }
    if(strcmp(kind, "input.left") == 0)  { send_input(app, InputKeyLeft);  send_reply(app, "OK:left");  return; }
    if(strcmp(kind, "input.right") == 0) { send_input(app, InputKeyRight); send_reply(app, "OK:right"); return; }
    if(strcmp(kind, "input.ok") == 0)    { send_input(app, InputKeyOk);    send_reply(app, "OK:ok");    return; }
    if(strcmp(kind, "input.back") == 0)  { send_input(app, InputKeyBack);  send_reply(app, "OK:back");  return; }
    if(strcmp(kind, "input.long_back") == 0) { send_input_long(app, InputKeyBack); send_reply(app, "OK:long_back"); return; }

    // Hub-app shortcuts (kept for backwards-compat with the prior palette).
    if(strcmp(kind, "nfc.scan") == 0) {
        launch_app(app, "nfc", "OK:opening_nfc");
        return;
    }
    if(strcmp(kind, "rfid.scan") == 0) {
        launch_app(app, "lfrfid", "OK:opening_rfid");
        return;
    }
    if(strcmp(kind, "favourites.list") == 0) {
        handle_favourites_list(app);
        return;
    }
    if(strcmp(kind, "favourites.run") == 0) {
        handle_favourites_run(app, arg);
        return;
    }

    send_reply(app, "ERR:unknown_kind");
}

int32_t flipctl_app(void* p) {
    UNUSED(p);

    Flipctl* app = malloc(sizeof(Flipctl));
    memset(app, 0, sizeof(Flipctl));
    status_set(app, "starting");

    app->input_queue = furi_message_queue_alloc(8, sizeof(InputEvent));
    app->line_queue = furi_message_queue_alloc(8, sizeof(char*));

    app->gui = furi_record_open(RECORD_GUI);
    app->view_port = view_port_alloc();
    view_port_draw_callback_set(app->view_port, draw_callback, app);
    view_port_input_callback_set(app->view_port, input_callback, app);
    gui_add_view_port(app->gui, app->view_port, GuiLayerFullscreen);

    app->bt = furi_record_open(RECORD_BT);
    app->loader = furi_record_open(RECORD_LOADER);
    app->storage = furi_record_open(RECORD_STORAGE);
    app->input_events = furi_record_open(RECORD_INPUT_EVENTS);

    // Switch BLE profile to Serial. This restarts the BT radio, so any active
    // central connection (i.e. the phone bridge) will briefly drop and
    // auto-reconnect via its connectGatt(autoConnect=true) loop.
    app->serial_profile = bt_profile_start(app->bt, ble_profile_serial, NULL);
    printf("[FLIPCTL] bt_profile_start returned %p\n", (void*)app->serial_profile);
    if(app->serial_profile) {
        // The bt service hooks its own RPC bridge into the serial profile on
        // every GAP connect, overwriting any callback we register up-front.
        // We register here AND from the status-changed callback (which fires
        // after each Connect) to keep our callback the active one.
        install_callback(app);
        bt_set_status_changed_callback(app->bt, status_changed_callback, app);
        status_set(app, "ready");
        printf("[FLIPCTL] ready: profile + callback installed\n");
    } else {
        status_set(app, "BLE start failed");
        printf("[FLIPCTL] bt_profile_start returned NULL\n");
    }
    view_port_update(app->view_port);

    bool exiting = false;
    while(!exiting) {
        InputEvent input;
        if(furi_message_queue_get(app->input_queue, &input, 50) == FuriStatusOk) {
            if((input.type == InputTypeShort || input.type == InputTypeLong) &&
               input.key == InputKeyBack) {
                exiting = true;
                break;
            }
        }

        char* line = NULL;
        while(furi_message_queue_get(app->line_queue, &line, 0) == FuriStatusOk) {
            if(line) {
                dispatch_line(app, line);
                free(line);
            }
        }

        view_port_update(app->view_port);
    }

    if(app->serial_profile) {
        bt_set_status_changed_callback(app->bt, NULL, NULL);
        ble_profile_serial_set_event_callback(app->serial_profile, 0, NULL, NULL);
        bt_profile_restore_default(app->bt);
        app->serial_profile = NULL;
    }

    view_port_enabled_set(app->view_port, false);
    gui_remove_view_port(app->gui, app->view_port);
    view_port_free(app->view_port);
    furi_record_close(RECORD_GUI);
    furi_record_close(RECORD_BT);
    furi_record_close(RECORD_LOADER);
    furi_record_close(RECORD_STORAGE);
    furi_record_close(RECORD_INPUT_EVENTS);

    char* line;
    while(furi_message_queue_get(app->line_queue, &line, 0) == FuriStatusOk) {
        if(line) free(line);
    }

    furi_message_queue_free(app->input_queue);
    furi_message_queue_free(app->line_queue);
    free(app);
    return 0;
}

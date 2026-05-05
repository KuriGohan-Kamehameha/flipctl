#pragma once

#include <furi.h>
#include <bt/bt_service/bt.h>
#include <profiles/serial_profile.h>
#include <gui/gui.h>
#include <gui/view_port.h>
#include <input/input.h>
#include <loader/loader.h>
#include <storage/storage.h>
#include <furi_hal_resources.h>

#define FLIPCTL_TAG               "Flipctl"
#define FLIPCTL_BT_RX_BUFFER      128
#define FLIPCTL_LINE_BUFFER       256
#define FLIPCTL_STATUS_LEN        48
#define FLIPCTL_REPLY_BUFFER      480     // BLE_SVC_SERIAL_DATA_LEN_MAX = 486
#define FLIPCTL_FAV_PATH          "/ext/favorites.txt"

typedef struct {
    Bt* bt;
    FuriHalBleProfileBase* serial_profile;
    Loader* loader;
    Storage* storage;
    FuriPubSub* input_events;
    uint32_t input_seq;

    Gui* gui;
    ViewPort* view_port;

    FuriMessageQueue* input_queue;
    FuriMessageQueue* line_queue;       // payload: char* (heap, recipient frees)

    char rx_line[FLIPCTL_LINE_BUFFER];
    size_t rx_line_len;
    bool rx_line_tainted;

    char status[FLIPCTL_STATUS_LEN];
} Flipctl;

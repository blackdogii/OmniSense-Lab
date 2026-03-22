#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

/**
 * OmniSense Lab - Global Configuration
 */

#define SERVICE_UUID           "FFE0"
#define CHARACTERISTIC_UUID_TX "FFE1" 
#define CHARACTERISTIC_UUID_RX "FFE2" 

const int ADC_PINS[] = {0, 1, 2, 3, 4, 5}; 
const int MAX_CHANNELS = 6;

#define PACKET_HEADER 0xAA
#define MAX_MTU 247

#define CMD_SET_CONFIG 0x01
#define CMD_CALIBRATE  0x02
#define CMD_REBOOT     0xFF

enum BitDepth {
    BIT_8 = 0,
    BIT_12 = 1,
    BIT_16 = 2
};

struct SystemConfig {
    uint8_t activeMask;   
    uint16_t sampleRate;  
    BitDepth resolution;  
    bool isRunning;       
};

extern SystemConfig g_sysConfig;

#endif

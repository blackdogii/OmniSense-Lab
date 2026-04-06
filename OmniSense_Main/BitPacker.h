/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：BLE 上行封包打包（標頭、mask、時間戳、樣本、checksum）。
 * 版本：見 Config.h 之 OMNISENSE_VERSION（x.y.z）。
 * 硬體：ESP32-C3
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#ifndef BIT_PACKER_H
#define BIT_PACKER_H

#include "Config.h"

class BitPacker {
public:
    static size_t pack(uint8_t* buffer, uint32_t timestamp, const uint16_t* rawData, uint8_t channelCount);
private:
    static uint8_t getChecksum(const uint8_t* data, size_t len);
};

#endif

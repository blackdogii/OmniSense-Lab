/*
 * OmniSense Lab — BitPacker（BLE 上行封包）
 * 目前釋出：0.4.3 · 版本規則：docs/VERSIONING.md
 * 作者：小威老師 · 授權：見倉庫 LICENSE
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

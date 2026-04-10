/*
 * OmniSense Lab — BitPacker 實作
 * 目前釋出：0.4.3 · 版本規則：docs/VERSIONING.md
 * 作者：小威老師 · 授權：見倉庫 LICENSE
 */
#include "BitPacker.h"
#include <cstring>
#include "Config.h"

/** timestamp：裝置端 micros()（微秒），供前端以真實時間間隔繪圖 */
size_t BitPacker::pack(uint8_t* buffer, uint32_t timestamp, const uint16_t* rawData, uint8_t channelCount) {
    size_t pos = 0;
    buffer[pos++] = PACKET_HEADER;
    uint16_t mask = g_sysConfig.activeMask;
    buffer[pos++] = (uint8_t)((mask >> 8) & 0xFF);
    buffer[pos++] = (uint8_t)(mask & 0xFF);
    buffer[pos++] = (uint8_t)g_sysConfig.resolution;
    memcpy(&buffer[pos], &timestamp, 4);
    pos += 4;

    if (g_sysConfig.resolution == BIT_8) {
        for (int i = 0; i < channelCount; i++) buffer[pos++] = (uint8_t)(rawData[i] >> 4);
    } else if (g_sysConfig.resolution == BIT_12) {
        for (int i = 0; i < channelCount; i += 2) {
            uint16_t v1 = rawData[i] & 0xFFF;
            uint16_t v2 = (i + 1 < channelCount) ? (rawData[i + 1] & 0xFFF) : 0;
            buffer[pos++] = (uint8_t)(v1 >> 4);
            buffer[pos++] = (uint8_t)(((v1 & 0x0F) << 4) | (v2 >> 8));
            buffer[pos++] = (uint8_t)(v2 & 0xFF);
        }
    } else {
        for (int i = 0; i < channelCount; i++) {
            buffer[pos++] = (uint8_t)((rawData[i] >> 8) & 0xFF);
            buffer[pos++] = (uint8_t)(rawData[i] & 0xFF);
        }
    }
    buffer[pos] = getChecksum(buffer, pos);
    return pos + 1;
}

uint8_t BitPacker::getChecksum(const uint8_t* data, size_t len) {
    uint8_t checksum = 0;
    for (size_t i = 0; i < len; i++) checksum ^= data[i];
    return checksum;
}

#pragma once

#include <Utils/CommonDefs.h>
#include <QObject>

#pragma pack(1)

enum RadarModes{
    RADAR_IDLE = 2,
    RADAR_SCAN = 5
};

typedef struct wrapTransform
{
    float transformation[3];
}wrapTransform;


#pragma pack()

#pragma once

// byte size literals
#include <stdint.h>
#include <Utils/CommonDefs.h>
#include <Devices/RadarDevice/RadarDefs.h>
#include <QMetaType>

constexpr char str_RadarDevice_1[] = "RadarDevice_1";
constexpr char str_RadarDevice_2[] = "RadarDevice_2";
constexpr char str_ParamStore[] = "ParamStore";
constexpr char str_ConfigStore[] = "ConfigStore";
constexpr char str_DDSBuilder[] = "DDSBuilder";
constexpr char str_RadarMgr[] = "RadarMgr";

const QString DATE_TIME_FORMAT          = "yyyy_MM_dd__hh_mm_ss_zzz";

#pragma pack(1)

static void RegisterAllMetaTypes()
{
    //----- ADD_NEW_MESSAGE_HERE ----------//
    qRegisterMetaType<uint8_t>("uint8_t");
    qRegisterMetaType<uint16_t>("uint16_t");
    qRegisterMetaType<PlatformTelemetryTopic>("PlatformTelemetryTopic");
    qRegisterMetaType<DetectionTopic>("DetectionTopic");
    qRegisterMetaType<EOPayloadStatusTopic>("EOPayloadStatusTopic");
    qRegisterMetaType<OperationMode>("OperationMode");
}

struct TopicRefNames
{
    std::string platformTelemetryTopicName;
    std::string detectionTopicName;
    std::string eoPayloadStatusTopicName;
    std::string PayloadInfoTopicName;
    std::string eoPayoadModeTopicName;
    std::string videoStatusTopicName;
};

struct FovConfigs
{
    float azimuthFovMin;
    float azimuthFovMax;
    float elevationFovMin;
    float elevationFovMax;
};

struct FovConfigsAerial : FovConfigs
{
    float aglHeightMin;
    float aglHeightMax;
};

struct RadarFiltersConfigs
{
    bool     groundFilterGround;
    float    groundSpeedMax;
    float    groundSpeedMin;
    uint16_t groundRangeMax;

    bool     aerialFilterUas;
    float    aerialSpeedMax;
    float    aerialSpeedMin;
    uint16_t aerialRangeMax;

    bool     allFilterUas;
    float    allSpeedMax;
    float    allSpeedMin;
    uint16_t allRangeMax;
};

struct RadarCommon
{
    uint16_t        detectionSample;
    uint16_t        videoStatusSample;
    uint16_t        eoPayloadStatusSample;
    float           installAngle        ;
    float           fovV                ;
    float           fovH                ;
    float           minRcs              ;
    float           maxRcs              ;
    uint16_t        rspClutterWidth     ;
};

struct RadarConfigs
{
    QString             radarName;
    QString             radarId;
    bool                isActive;
    float               installRoll;
    float               installPitch;
    float               installYaw;
    QString             serverId;
    uint16_t            serverPort;
    float               probUav;
    uint16_t            aerialClassAgl;
    uint16_t            detectionMode;
    FovConfigs          allFovConfigs;
    FovConfigs          groundFovConfigs;
    FovConfigsAerial    aerialFovConfigs;
    RadarFiltersConfigs filterConfigs;
    int8_t              frequencyChannel;
};

struct ApplicationParams
{
    QString         logLevel;
    QString         qosLinuxPath;
    QString         recordingLinuxPath;
    QString         qosWinPath;
    QString         recordingWinPath;
    QString         payloadId;
    QString         platformId;
};


#pragma pack()

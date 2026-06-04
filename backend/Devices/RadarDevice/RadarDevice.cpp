
#include "RadarDevice.h"
#include <QDateTime>
#include <QJsonArray>


RadarDevice::RadarDevice(const QString& szObjectName, RadarConfigs radarConfig):
    ObjectBase(szObjectName), m_radarConfigs(radarConfig)
{

    m_pParamStore = ObjectStore::GetReference().GetObjectByName<ParamStore>(str_ParamStore);
    m_checkHeightFilterForDrones = m_pParamStore->getCheckHeightFilterForDrones();
    m_topicNames = m_pParamStore->topic_names();

#ifndef linux
    QString szBaseFolder = m_pParamStore->app_common().recordingWinPath;
#else
    QString szBaseFolder = m_pParamStore->app_common().recordingLinuxPath;
#endif
    auto now = QDateTime::currentDateTime();


    QString sessionTime = now.toString(DATE_TIME_FORMAT);
    m_szSessionFolder = QString("%1/%2").arg(szBaseFolder).arg(sessionTime);

    QDir dir(m_szSessionFolder);
    if (!dir.exists())
    {
        QDir().mkpath(m_szSessionFolder);
    }

    /*--------------------------------------DDS Removed--------------------------------------------*/
}

RadarDevice::~RadarDevice(){}

void RadarDevice::Initialize(){}

void RadarDevice::Run()
{
    m_pParamStore       = ObjectStore::GetReference().GetObjectByName<ParamStore>(str_ParamStore);
    m_radarCommonParams = m_pParamStore->radar_common();
    m_appParams         = m_pParamStore->app_common();

    if(doConnect()){
        m_detectionSampleTimer   = new QTimer(this);
        connect(m_detectionSampleTimer,    &QTimer::timeout, this, &RadarDevice::checkTrack);
        // Make sure Radar is stopped
        sendCommand("MODE:SWT:STOP", "");
    }
    else{
        LOG_WARNING() << "Connection to radar " << m_radarConfigs.serverId << " failed. Radar will remain inactive.";
    }
}

/* -------------------------------Communication------------------------------------*/
bool RadarDevice::doConnect()
{
    try
    {
        const FovConfigs fovConfigs = getRadarConfigs();
        std::pair<mesa_command_status_t, std::string> cmdResponse;
        LOG_INFO() << "Connecting to: " << m_radarConfigs.serverId.toStdString() << " ...";

        m_bnet.connect(m_radarConfigs.serverId.toStdString(),m_radarConfigs.serverPort, m_szSessionFolder.toStdString());//"/home/nvida/Desktop");

        //Get Radar INFO
        cmdResponse = sendCommand("*IDN?", "");
        LOG_INFO() << "Radar info: " + cmdResponse.second;

        // Set Radar DMS:CHANNEL
        cmdResponse = sendCommand("DMS:CHANNEL ", std::to_string(static_cast<int>(m_radarConfigs.frequencyChannel)));
        LOG_INFO() << "DMS:CHANNEL " +  std::to_string(static_cast<int>(m_radarConfigs.frequencyChannel)) + " - " + cmdResponse.second;

        // Set Radar ELFFOVMIN
        cmdResponse = sendCommand("MODE:SWT:SEARCH:ELFOVMIN ", std::to_string(static_cast<int>(fovConfigs.elevationFovMin)));
        LOG_INFO() << "MODE:SWT:SEARCH:ELFOVMIN " +  std::to_string(static_cast<int>(fovConfigs.elevationFovMin)) + " - " + cmdResponse.second;

        // Set Radar ELFFOVMAX
        cmdResponse = sendCommand("MODE:SWT:SEARCH:ELFOVMAX ", std::to_string(static_cast<int>(fovConfigs.elevationFovMax)));
        LOG_INFO() << "MODE:SWT:SEARCH:ELFOVMAX "+  std::to_string(static_cast<int>(fovConfigs.elevationFovMax)) + " - " + cmdResponse.second;

        // Set Radar RSP:RCSMASK:MINRCS
        cmdResponse = sendCommand("RSP:RCSMASK:MINRCS ", std::to_string(static_cast<float>(m_radarCommonParams.minRcs)));
        LOG_INFO() << "RSP:RCSMASK:MINRCS "+  std::to_string(static_cast<float>(m_radarCommonParams.minRcs)) + " - " + cmdResponse.second;

        // Set Radar RSP:RCSMASK:MAXRCS
        cmdResponse = sendCommand("RSP:RCSMASK:MAXRCS ", std::to_string(static_cast<float>(m_radarCommonParams.maxRcs)));
        LOG_INFO() << "RSP:RCSMASK:MAXRCS "+  std::to_string(static_cast<float>(m_radarCommonParams.maxRcs)) + " - " + cmdResponse.second;

        // Set Radar RSP:CLUTTERMASKWIDTH
        cmdResponse = sendCommand("RSP:CLUTTERMASKWIDTH eldorado ", std::to_string(static_cast<int>(m_radarCommonParams.rspClutterWidth)));
        LOG_INFO() << "RSP:CLUTTERMASKWIDTH eldorado "+  std::to_string(static_cast<int>(m_radarCommonParams.rspClutterWidth)) + " - " + cmdResponse.second;

        // Set Radar RANGE:MASK
        cmdResponse = sendCommand("RANGE:MASK eldorado 0,128,134,0,31", "");
        LOG_INFO() << "RANGE:MASK eldorado 0,128,134,0,31 - " + cmdResponse.second;

        // Set Radar RANGE:MASK
        std::string tempCmd= "";
        tempCmd.append("RANGE:MASK eldorado 1,");
        tempCmd.append(std::to_string((int(m_radarConfigs.filterConfigs.aerialRangeMax / 3.25)) + 128));
        tempCmd.append(",2047,0,31");
        cmdResponse = sendCommand(tempCmd, "");
        LOG_INFO() << "tempCmd - " + cmdResponse.second;

        cmdResponse = sendCommand("SYSPARAM? eldorado", "");
        LOG_INFO() << "RADAR SYSPARAMS eldorado " << cmdResponse.second;

        //Enable Tracks data
        m_bnet.set_collect(mesa_data_t::TRACK_DATA,true);
        m_bnet.set_collect(mesa_data_t::STATUS_DATA,true);
    }
    catch(std::exception ex)
    {
        LOG_WARNING() << "Got exception from bnet: " << ex.what();
        return false;
    }

    return true;
}

void RadarDevice::checkTrack()
{
    auto n_track = m_bnet.get_n_buffered(TRACK_DATA);
    LOG_DEBUG() << "Got " << std::to_string(n_track) << " track packets";

    m_currentSurfaceHeight = m_platformTelemetryTopicMsg.position.position.altitude - m_platformTelemetryTopicMsg.relative_takeoff_altitude;
    LOG_DEBUG() << "Current surface height is " << std::to_string(m_currentSurfaceHeight);

    if (n_track < 1)
    {
        return;
    }
    // Get a packet
    for (int n = 0; n < n_track; ++n)
    {
        if(n != 0)break;
        auto packet = m_bnet.get_track();
        if (packet.header->nTracks == 0)
        {
            continue;
        }
        auto radarStatus = m_bnet.get_status();

        LOG_DEBUG() << "Quternion w received: " << radarStatus.data->quat_w;
        LOG_DEBUG() << "Quternion x received: " << radarStatus.data->quat_x;
        LOG_DEBUG() << "Quternion y received: " << radarStatus.data->quat_y;
        LOG_DEBUG() << "Quternion z received: " << radarStatus.data->quat_z;

        LOG_DEBUG() << "Lat from telemetry: " << m_platformTelemetryTopicMsg.position.position.latitude;
        LOG_DEBUG() << "Long from telemetry: " << m_platformTelemetryTopicMsg.position.position.longitude;
        LOG_DEBUG() << "Alt from telemetry: " << m_platformTelemetryTopicMsg.position.position.altitude;

        LOG_INFO() << "*************************************************************";

        for (int i = 0; i < packet.header->nTracks; ++i)
        {
			LOG_INFO() << "------------------------------------------";
            LOG_INFO() << "Track Packet: " << std::to_string(n) << " Track number in the packet: " << std::to_string(i) << ": " << "ID = " << packet.data[i].ID;
            LOG_INFO() << "------------------------------------------";
            LOG_INFO() << "Azest: " << packet.data[i].azest;
            LOG_INFO() << "Elest: " << packet.data[i].elest;
            LOG_INFO() << "Range: " << packet.data[i].rest;
            LOG_INFO() << "------------------------------------------";
            writeDetectionTopic(packet.data[i], radarStatus.data);
        }
    }

    std::cout << std::endl;
}

/* ---------------------------------Writers---------------------------------------*/
void RadarDevice::writeDetectionTopic(track_data track, sstat_data* radarStatusData)
{
    QString detectionUniqeId = "";
    bool isRelevant;
    wrapTransform wrapper;
    
    detectionUniqeId.append(m_pParamStore->platformId());
    detectionUniqeId.append("_");
    detectionUniqeId.append(m_pParamStore->payloadId());
    detectionUniqeId.append("_");
    detectionUniqeId.append(m_radarConfigs.radarId);
    detectionUniqeId.append("_");
    detectionUniqeId.append(QString::number(track.ID));

    m_detectionMsg["id"] = detectionUniqeId;
    m_detectionMsg["radarId"] = m_radarConfigs.radarId;

    LOG_DEBUG() << "Prob UAV: " << track.probabilityUAV;
    LOG_DEBUG() << "Estimate RCS confidence level: " << track.estConfidence;
    LOG_DEBUG() << "Estimate RCS: " << track.estRCS << " db";

    wrapper = convertRadarAzElR2GeoTelemFromUav(m_platformTelemetryTopicMsg.position.position.latitude,
                                      m_platformTelemetryTopicMsg.position.position.longitude,
                                      m_platformTelemetryTopicMsg.position.position.altitude,
                                      deg2rad(track.azest),
                                      deg2rad(track.elest),
                                      track.rest,
                                      m_platformTelemetryTopicMsg.position.orientation.roll,
                                      m_platformTelemetryTopicMsg.position.orientation.pitch,
                                      m_platformTelemetryTopicMsg.position.orientation.yaw,
                                      m_radarConfigs.installRoll,
                                      m_radarConfigs.installPitch,
                                      m_radarConfigs.installYaw
                                      );

    m_detectionMsg["lat"] = wrapper.transformation[0];
    m_detectionMsg["lng"] = wrapper.transformation[1];
    m_detectionMsg["alt"] = wrapper.transformation[2];

    setClassifiction(track);

    if(!(m_detectionsList.contains(detectionUniqeId)))
    {
        isRelevant = applyConfigFilters(track, m_detectionMsg["classification"].toInt());
        if(!isRelevant){
         LOG_INFO() << "Detection isnt relevant";
         return;
        }

        if(m_detectionMsg["classification"].toInt() == 1) // 1 for Drone
        {
            m_detectionsList.append(detectionUniqeId);
            LOG_DEBUG() << "Append track to track list, list length: " << m_detectionsList.length();
        }

    }
    else
    {
        m_detectionMsg["classification"] = 1; // Drone

        if(m_checkHeightFilterForDrones)
        {
            isRelevant = applyConfigFilters(track, m_detectionMsg["classification"].toInt());
            if(!isRelevant){
             LOG_INFO() << "Drone isnt relevant - failed on filters";
             return;
            }
        }
    }

    float speed = qSqrt(qPow(track.velxest, 2) + qPow(track.velyest, 2) + qPow(track.velzest, 2));
    m_detectionMsg["speed"] = speed;
    m_detectionMsg["heading"] = track.azest;
    m_detectionMsg["confidence"] = track.probabilityUAV * 100;

    int64_t timestamp = Utils::currentSystemTimeMicros();
    m_detectionMsg["lastUpdated"] = timestamp / 1000; // ms

    LOG_INFO() << "emit signalDetectionReceived";
    emit signalDetectionReceived(m_detectionMsg);
}

/* ----------------------------------Slots----------------------------------------*/
void RadarDevice::slotHandlePlatformTelemetryTopic(PlatformTelemetryTopic telemetryTopic)
{
    m_platformTelemetryTopicMsg = telemetryTopic;
}

void RadarDevice::slotHandleEoPayloadControlModeTopic(OperationMode mode)
{
    LOG_DEBUG() << "In slotHandleEoPayloadControlModeTopic";
    auto radarStatus = m_bnet.get_status();
    std::pair<mesa_command_status_t, std::string> res = std::make_pair(MESA_OK, "");

    switch (mode) {
        case OperationMode::OPERATION_MODE_SCAN:
            LOG_INFO() << "Current system state: " << radarStatus.data->sys_state;
            if(radarStatus.data->sys_state != RADAR_SCAN)
            {
                LOG_INFO() << "Scan mode received, sending scan command to radar";
                res = sendCommand("MODE:SWT:START", ""); // Changes system state to 5
                LOG_INFO() << "Command MODE:SWT:START, status: " << res.second;
                m_detectionSampleTimer->start(m_radarCommonParams.detectionSample);
            }
            else
            {
                LOG_INFO() << "Radar already in Scan";
            }

            break;

        case OperationMode::OPERATION_MODE_IDLE:
            LOG_INFO() << "Current system state: " << radarStatus.data->sys_state;
            m_detectionSampleTimer->stop();
            if(radarStatus.data->sys_state != RADAR_IDLE)
            {
                LOG_INFO() << "IDLE mode received, sending stop command to radar";
                res = sendCommand("MODE:SWT:STOP", "");
                LOG_INFO() << "Command MODE:SWT:STOP, status: " << res.second;
            }
            else
            {
                LOG_INFO() << "Radar already in Idle";
            }

            break;

        case OperationMode::OPERATION_MODE_GROUND_DETECTIONS:
            m_radarConfigs.detectionMode = OperationMode::OPERATION_MODE_GROUND_DETECTIONS;
            LOG_INFO() << "OPERATION_MODE_GROUND_DETECTIONS received, change configurations & filters";

            break;


        case OperationMode::OPERATION_MODE_AERIAL_DETECTIONS:
            m_radarConfigs.detectionMode = OperationMode::OPERATION_MODE_AERIAL_DETECTIONS;
            LOG_INFO() << "OPERATION_MODE_AERIAL_DETECTIONS received, change configurations & filters";

            break;


        case OperationMode::OPERATION_MODE_ALL_DETECTIONS:
            m_radarConfigs.detectionMode = OperationMode::OPERATION_MODE_ALL_DETECTIONS;
            LOG_INFO() << "OPERATION_MODE_ALL_DETECTIONS received, change configurations & filters";

            break;

        default:
            break;
    }
    return;
}

/* ------------------------------Miscellaneous------------------------------------*/
float RadarDevice::deg2rad(float degree)
{
    return (degree * (M_PI / 180));
}

bool RadarDevice::applyConfigFilters(track_data track, uint8_t classification)
{
    bool isRelevant = true;
    float avgSpeed;
    avgSpeed = qSqrt(qPow(track.velxest ,2) + qPow(track.velyest ,2) + qPow(track.velzest ,2));
    LOG_DEBUG() << "Track calculated speed: " << avgSpeed;
    switch (m_radarConfigs.detectionMode) {
    case OperationMode::OPERATION_MODE_GROUND_DETECTIONS:
        printGroundFilters(track, avgSpeed);
        if(track.rest > m_radarConfigs.filterConfigs.groundRangeMax) isRelevant = false;
        if(avgSpeed > m_radarConfigs.filterConfigs.groundSpeedMax) isRelevant = false;
        if(avgSpeed < m_radarConfigs.filterConfigs.groundSpeedMin) isRelevant = false;
        if(m_radarConfigs.filterConfigs.groundFilterGround == true)
        {
            if(classification != Classification_Constants::UNKNOWN_) isRelevant = false;
        }
        if(track.azest > m_radarConfigs.groundFovConfigs.azimuthFovMax) isRelevant = false;
        if(track.azest < m_radarConfigs.groundFovConfigs.azimuthFovMin) isRelevant = false;
        if(track.elest > m_radarConfigs.groundFovConfigs.elevationFovMax) isRelevant = false;
        if(track.elest < m_radarConfigs.groundFovConfigs.elevationFovMin) isRelevant = false;
        break;

    case OperationMode::OPERATION_MODE_AERIAL_DETECTIONS:
        printAerialFilters(track, avgSpeed);
        if(track.rest > m_radarConfigs.filterConfigs.aerialRangeMax) isRelevant = false;
        if(avgSpeed > m_radarConfigs.filterConfigs.aerialSpeedMax) isRelevant = false;
        if(avgSpeed < m_radarConfigs.filterConfigs.aerialSpeedMin) isRelevant = false;
        if(m_radarConfigs.filterConfigs.aerialFilterUas == true)
        {
            if(classification != Classification_Constants::DRONE_) isRelevant = false;
        }
        if(track.azest > m_radarConfigs.aerialFovConfigs.azimuthFovMax) isRelevant = false;
        if(track.azest < m_radarConfigs.aerialFovConfigs.azimuthFovMin) isRelevant = false;
        if(track.elest > m_radarConfigs.aerialFovConfigs.elevationFovMax) isRelevant = false;
        if(track.elest < m_radarConfigs.aerialFovConfigs.elevationFovMin) isRelevant = false;

        float detectionHeightAboveSurface = m_detectionMsg["alt"].toDouble() - m_currentSurfaceHeight;
        if(detectionHeightAboveSurface > m_radarConfigs.aerialFovConfigs.aglHeightMax) isRelevant = false;
        if(detectionHeightAboveSurface < m_radarConfigs.aerialFovConfigs.aglHeightMin) isRelevant = false;

        break;
    case OperationMode::OPERATION_MODE_ALL_DETECTIONS:
        printAllFilters(track, avgSpeed);
        if(track.rest > m_radarConfigs.filterConfigs.allRangeMax) isRelevant = false;
        if(avgSpeed > m_radarConfigs.filterConfigs.allSpeedMax) isRelevant = false;
        if(avgSpeed < m_radarConfigs.filterConfigs.allSpeedMin) isRelevant = false;
        if(m_radarConfigs.filterConfigs.allFilterUas == true)
        {
            if(classification != Classification_Constants::DRONE_) isRelevant = false;
        }
        if(track.azest > m_radarConfigs.allFovConfigs.azimuthFovMax) isRelevant = false;
        if(track.azest < m_radarConfigs.allFovConfigs.azimuthFovMin) isRelevant = false;
        if(track.elest > m_radarConfigs.allFovConfigs.elevationFovMax) isRelevant = false;
        if(track.elest < m_radarConfigs.allFovConfigs.elevationFovMin) isRelevant = false;
        break;
    default:
        isRelevant = false;
        break;
    }
    return isRelevant;
}

FovConfigs RadarDevice::getRadarConfigs()
{
    switch (m_radarConfigs.detectionMode) {
    case OperationMode::OPERATION_MODE_GROUND_DETECTIONS:
        return m_radarConfigs.groundFovConfigs;
        break;
    case OperationMode::OPERATION_MODE_AERIAL_DETECTIONS:
        return m_radarConfigs.aerialFovConfigs;
        break;
    case OperationMode::OPERATION_MODE_ALL_DETECTIONS:
        return m_radarConfigs.allFovConfigs;
        break;
    default:
        break;
    }
}

std::pair<mesa_command_status_t, std::string> RadarDevice::sendCommand(std::string cmd, std::string cmdParam)
{
    std::pair<mesa_command_status_t, std::string> cmdResponse = m_bnet.send_command(cmd.append(cmdParam));
    return cmdResponse;
}

void RadarDevice::setClassifiction(track_data track)
{
    if(track.probabilityUAV > m_radarConfigs.probUav)
    {
        m_detectionMsg["classification"] = 1; // DRONE
        m_detectionMsg["class_name"] = "drone";
    }
    else if(m_detectionMsg["alt"].toDouble() - m_currentSurfaceHeight > m_radarConfigs.aerialClassAgl)
    {
        m_detectionMsg["classification"] = 2; // UNKNOWN_AERIAL
        m_detectionMsg["class_name"] = "unknown";
    }
    else
    {
        m_detectionMsg["classification"] = 3; // UNKNOWN
        m_detectionMsg["class_name"] = "unknown";
    }
}

/* ------------------------------Logs------------------------------------*/
void RadarDevice::printGroundFilters(track_data &track, float trackAvgSpeed)
{
    LOG_DEBUG() << "Track range: " << track.rest << ", Config range max: " << m_radarConfigs.filterConfigs.groundRangeMax;
    LOG_DEBUG() << "Track velocity : " << trackAvgSpeed << ", Config velocity max: " << m_radarConfigs.filterConfigs.groundSpeedMax;
    LOG_DEBUG() << "Track velocity : " << trackAvgSpeed << ", Config velocity min: " << m_radarConfigs.filterConfigs.groundSpeedMin;
    LOG_DEBUG() << "Track probability other: " << track.probabilityOther << ", Track probability UAV: " << track.probabilityUAV;
    LOG_DEBUG() << "Track azimuth: " << track.azest << ", Config azimuth fov max: " << m_radarConfigs.groundFovConfigs.azimuthFovMax;
    LOG_DEBUG() << "Track azimuth: " << track.azest << ", Config azimuth fov min: " << m_radarConfigs.groundFovConfigs.azimuthFovMin;
    LOG_DEBUG() << "Track elevation: " << track.elest << ", Config elevation fov max: " << m_radarConfigs.groundFovConfigs.elevationFovMax;
    LOG_DEBUG() << "Track elevation: " << track.elest << ", Config elevation fov min: " << m_radarConfigs.groundFovConfigs.elevationFovMin;
}

void RadarDevice::printAerialFilters(track_data &track, float trackAvgSpeed)
{
    LOG_DEBUG() << "Track range: " << track.rest << ", Config range max: " << m_radarConfigs.filterConfigs.aerialRangeMax;
    LOG_DEBUG() << "Track velocity : " << trackAvgSpeed << ", Config velocity max: " << m_radarConfigs.filterConfigs.aerialSpeedMax;
    LOG_DEBUG() << "Track velocity : " << trackAvgSpeed << ", Config velocity min: " << m_radarConfigs.filterConfigs.aerialSpeedMin;
    LOG_DEBUG() << "Track probability other: " << track.probabilityOther << ", Track probability UAV: " << track.probabilityUAV;
    LOG_DEBUG() << "Track azimuth: " << track.azest << ", Config azimuth fov max: " << m_radarConfigs.aerialFovConfigs.azimuthFovMax;
    LOG_DEBUG() << "Track azimuth: " << track.azest << ", Config azimuth fov min: " << m_radarConfigs.aerialFovConfigs.azimuthFovMin;
    LOG_DEBUG() << "Track elevation: " << track.elest << ", Config elevation fov max: " << m_radarConfigs.aerialFovConfigs.elevationFovMax;
    LOG_DEBUG() << "Track elevation: " << track.elest << ", Config elevation fov min: " << m_radarConfigs.aerialFovConfigs.elevationFovMin;
}

void RadarDevice::printAllFilters(track_data &track, float trackAvgSpeed)
{
    LOG_DEBUG() << "Track range: " << track.rest << ", Config range max: " << m_radarConfigs.filterConfigs.allRangeMax;
    LOG_DEBUG() << "Track velocity : " << trackAvgSpeed << ", Config velocity max: " << m_radarConfigs.filterConfigs.allSpeedMax;
    LOG_DEBUG() << "Track velocity : " << trackAvgSpeed << ", Config velocity min: " << m_radarConfigs.filterConfigs.allSpeedMin;
    LOG_DEBUG() << "Track probability other: " << track.probabilityOther << ", Track probability UAV: " << track.probabilityUAV;
    LOG_DEBUG() << "Track azimuth: " << track.azest << ", Config azimuth fov max: " << m_radarConfigs.allFovConfigs.azimuthFovMax;
    LOG_DEBUG() << "Track azimuth: " << track.azest << ", Config azimuth fov min: " << m_radarConfigs.allFovConfigs.azimuthFovMin;
    LOG_DEBUG() << "Track elevation: " << track.elest << ", Config elevation fov max: " << m_radarConfigs.allFovConfigs.elevationFovMax;
    LOG_DEBUG() << "Track elevation: " << track.elest << ", Config elevation fov min: " << m_radarConfigs.allFovConfigs.elevationFovMin;
}

void RadarDevice::printTrack(track_data track)
{
    LOG_DEBUG() << "Xest: " << track.xest;
    LOG_DEBUG() << "Yest: " << track.yest;
    LOG_DEBUG() << "Zest: " << track.zest;
    LOG_DEBUG() << "Azest: " << track.azest;
    LOG_DEBUG() << "Elest: " << track.elest;
    LOG_DEBUG() << "rest: " << track.rest;
}

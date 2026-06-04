#include "Builder.h"
#include <Utils/ObjectBase.h>
#include <memory.h>
#include <Common/ProjectDefs.h>

//--------------- Logging ----------------/
#include <Utils/Logger.h>

//---------------Devices -----------------------------/
#include <Utils/CommonDefs.h>

#include <Devices/RadarDevice/RadarDevice.h>
#include <Devices/RadarDevice/RadarMgr.h>

//---------------Project Configurations----------------/
#include <Files/ParamStore.h>
#include <Files/FileStore.h>
#include <Files/ConfigStore.h>
#include <Files/VersionStore.h>
#include "DDSBuilder.h"


Builder::Builder(QString baseDirectory):m_baseDir(baseDirectory)
{
    RegisterAllMetaTypes();

    // constructor
    InitLogger(m_baseDir.toStdString());
}

void Builder::BuildFiles(QString szConfigurationFile)
{
    //------------ Build all file handlers -------------------//

    auto pFileStore = new FileStore("FileStore", m_baseDir + "/" + "config/FileStore.ini");
    ObjectStore::GetReference().InsertObject(pFileStore->objectName(), pFileStore);

#ifdef linux
    auto pConfigStore = new ConfigStore("ConfigStore", m_baseDir + "/" + pFileStore->szConfigStorePathTegra() );
#else
    auto pConfigStore = new ConfigStore("ConfigStore", m_baseDir + "/" + pFileStore->szConfigStorePathWin() );
#endif
    ObjectStore::GetReference().InsertObject(pConfigStore->objectName(), pConfigStore);

    auto pParamStore = new ParamStore("ParamStore", m_baseDir + "/" + pFileStore->szParamStorePath() );
    ObjectStore::GetReference().InsertObject(pParamStore->objectName(), pParamStore);

    auto pVersionStore = new VersionStore("VersionStore", m_baseDir + "/" + pFileStore->szVersionStorePath());
    ObjectStore::GetReference().InsertObject(pVersionStore->objectName(), pVersionStore);

    LOG_WARNING() << "Radar Version " << pVersionStore->szRadarVersion().toStdString();

    m_log_level = pParamStore->app_common().logLevel;

}

void Builder::BuildConstructors()
{
    auto pParamStore = ObjectStore::GetReference().GetObjectByName<ParamStore>(str_ParamStore);

    LOG_INFO() << "Building application ";

    // --- Devices --- //

    auto pDDSBuilder = new DDSBuilder(str_DDSBuilder);
    ObjectStore::GetReference().InsertObject(pDDSBuilder->objectName(), pDDSBuilder);
    InsertManager(pDDSBuilder);

    auto pRadarMgr = new RadarMgr(str_RadarMgr);
    ObjectStore::GetReference().InsertObject(pRadarMgr->objectName(), pRadarMgr);
    InsertManager(pRadarMgr);

    // --- Radar Devices --- //
    std::tuple <RadarConfigs, RadarConfigs> pRadarConfig = pParamStore->radarConfigs();
    RadarConfigs pRadarConfig_1 = std::get<0>(pRadarConfig);
    RadarConfigs pRadarConfig_2 = std::get<1>(pRadarConfig);

    if(pRadarConfig_1.isActive)
    {
        auto pRadarDevice = new RadarDevice(pRadarConfig_1.radarName, pRadarConfig_1);
        pRadarMgr->m_radarDeviceList.append(pRadarDevice);
        ObjectStore::GetReference().InsertObject(pRadarDevice->objectName(), pRadarDevice);
        InsertManager(pRadarDevice);
    }
    if(pRadarConfig_2.isActive)
    {
        auto pRadarDevice = new RadarDevice(pRadarConfig_2.radarName, pRadarConfig_2);
        pRadarMgr->m_radarDeviceList.append(pRadarDevice);
        ObjectStore::GetReference().InsertObject(pRadarDevice->objectName(), pRadarDevice);
        InsertManager(pRadarDevice);
    }

//    if(!pRadarConfig_1.isActive && !pRadarConfig_2.isActive)
//    {
//        LOG_WARNING() << "No active radars, closing application";
//        std::exit(0);
//    }

    LOG_INFO() << "After building application ";

    SetLogLevel();
}

void Builder::SetLogLevel()
{
    if(m_log_level.compare("TRACE_LOG") == 0)
        SetSeverityLevel(boost::log::trivial::trace);
    else if(m_log_level.compare("DEBUG_LOG") == 0)
        SetSeverityLevel(boost::log::trivial::debug);
    else if(m_log_level.compare("INFO_LOG") == 0)
        SetSeverityLevel(boost::log::trivial::info);
    else if(m_log_level.compare("WARNING_LOG") == 0)
        SetSeverityLevel(boost::log::trivial::warning);
    else if(m_log_level.compare("ERROR_LOG") == 0)
        SetSeverityLevel(boost::log::trivial::error);
    else if(m_log_level.compare("FATAL_LOG") == 0)
        SetSeverityLevel(boost::log::trivial::fatal);
}



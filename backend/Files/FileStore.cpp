#include "FileStore.h"
#include <QSettings>


FileStore::FileStore(const QString& szObjectName, const QString& szPath):
    ObjectBase(szObjectName)
{
    m_settings = new QSettings(szPath, QSettings::IniFormat);

    m_settings->beginGroup("Files");
    m_szConfigStorePathWin      = m_settings->value("CONFIG_STORE_FILE_PATH_WIN",   "config/ConfigStore_win.ini").toString();
    m_szConfigStorePathTegra    = m_settings->value("CONFIG_STORE_FILE_PATH_TEGRA", "config/ConfigStore_tegra.ini").toString();
    m_szParamStorePath          = m_settings->value("PARAM_STORE_FILE_PATH", "config/ParamStore.ini").toString();
    m_szVersionStorePath        = m_settings->value("VERSION_STORE_FILE_PATH", "config/VersionStore.ini").toString();
}

FileStore::~FileStore()
{
    delete m_settings;
}

#include "VersionStore.h"
#include <QSettings>


VersionStore::VersionStore(const QString& szObjectName, const QString& szPath):
    ObjectBase(szObjectName)
{
    m_settings = new QSettings(szPath, QSettings::IniFormat);

    m_szRadarVersion = m_settings->value("Versions/VERSION_STORE_RADAR").toString();
}

VersionStore::~VersionStore()
{
    delete m_settings;
}

const QString& VersionStore::szRadarVersion()
{
    return m_szRadarVersion;
}

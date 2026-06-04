#include "ConfigStore.h"
#include <QSettings>


ConfigStore::ConfigStore(const QString& szObjectName, const QString& szPath):
    ObjectBase(szObjectName)
{
    m_settings = new QSettings(szPath, QSettings::IniFormat);
}

ConfigStore::~ConfigStore()
{
    delete m_settings;
}

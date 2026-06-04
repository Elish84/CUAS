#pragma once

#include <Utils/ObjectBase.h>

class QSettings;

class VersionStore : public ObjectBase
{
    Q_OBJECT

public:

    VersionStore(const QString& szObjectName, const QString& szPath);

    ~VersionStore();

    const QString& szRadarVersion();

private:

    //QString m_szVersionStorePath = "";
    QSettings* m_settings = nullptr;

    QString  m_szRadarVersion;

};


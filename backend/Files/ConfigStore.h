#pragma once

#include <Utils/ObjectBase.h>


class QSettings;

class ConfigStore : public ObjectBase
{
    Q_OBJECT

public:

    ConfigStore(const QString& szObjectName, const QString& szPath);

    ~ConfigStore();



private:

    QSettings* m_settings = nullptr;
};


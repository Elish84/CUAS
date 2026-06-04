#pragma once

#include <Utils/ObjectBase.h>


class QSettings;

class FileStore : public ObjectBase
{
    Q_OBJECT

public:

    FileStore(const QString& szObjectName, const QString& szPath);

    ~FileStore();

    const QString& szParamStorePath(){return m_szParamStorePath;}
    const QString& szConfigStorePathWin(){return m_szConfigStorePathWin;}
    const QString& szConfigStorePathTegra(){return m_szConfigStorePathTegra;}
    const QString& szVersionStorePath(){return m_szVersionStorePath;}

private:

    QString m_szVersionStorePath        = "";
    QString m_szParamStorePath          = "";
    QString m_szConfigStorePathWin      = "";
    QString m_szConfigStorePathTegra    = "";

    QSettings* m_settings = nullptr;
};

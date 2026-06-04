#ifndef WEBSOCKETMGR_H
#define WEBSOCKETMGR_H

#include <QObject>
#include <QWebSocketServer>
#include <QWebSocket>
#include <QList>
#include <QJsonObject>
#include <QJsonDocument>

class WebsocketMgr : public QObject
{
    Q_OBJECT
public:
    explicit WebsocketMgr(quint16 port, QObject *parent = nullptr);
    ~WebsocketMgr();

signals:
    // Emitted when a UI command is received (e.g. Turn On/Off, Set Home)
    void commandReceived(const QJsonObject& command);

public slots:
    // Slot to be connected to RadarDevice's signal for new detections
    void broadcastDetection(const QJsonObject& detection);
    // Slot to update radar status
    void broadcastStatus(const QJsonObject& status);

private slots:
    void onNewConnection();
    void processTextMessage(QString message);
    void socketDisconnected();

private:
    QWebSocketServer *m_pWebSocketServer;
    QList<QWebSocket *> m_clients;
};

#endif // WEBSOCKETMGR_H

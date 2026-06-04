#include "WebsocketMgr.h"
#include <QDebug>

WebsocketMgr::WebsocketMgr(quint16 port, QObject *parent) :
    QObject(parent),
    m_pWebSocketServer(new QWebSocketServer(QStringLiteral("Radar Server"),
                                            QWebSocketServer::NonSecureMode, this))
{
    if (m_pWebSocketServer->listen(QHostAddress::Any, port)) {
        qDebug() << "WebSocket server listening on port" << port;
        connect(m_pWebSocketServer, &QWebSocketServer::newConnection,
                this, &WebsocketMgr::onNewConnection);
    } else {
        qDebug() << "WebSocket server failed to start!";
    }
}

WebsocketMgr::~WebsocketMgr()
{
    m_pWebSocketServer->close();
    qDeleteAll(m_clients.begin(), m_clients.end());
}

void WebsocketMgr::onNewConnection()
{
    QWebSocket *pSocket = m_pWebSocketServer->nextPendingConnection();
    qDebug() << "Client connected:" << pSocket->peerAddress().toString();

    connect(pSocket, &QWebSocket::textMessageReceived, this, &WebsocketMgr::processTextMessage);
    connect(pSocket, &QWebSocket::disconnected, this, &WebsocketMgr::socketDisconnected);

    m_clients << pSocket;
}

void WebsocketMgr::processTextMessage(QString message)
{
    QJsonDocument doc = QJsonDocument::fromJson(message.toUtf8());
    if(!doc.isNull() && doc.isObject()) {
        emit commandReceived(doc.object());
    } else {
        qDebug() << "Invalid JSON command received over WebSocket";
    }
}

void WebsocketMgr::socketDisconnected()
{
    QWebSocket *pClient = qobject_cast<QWebSocket *>(sender());
    if (pClient) {
        m_clients.removeAll(pClient);
        pClient->deleteLater();
        qDebug() << "Client disconnected";
    }
}

void WebsocketMgr::broadcastDetection(const QJsonObject& detection)
{
    QJsonDocument doc(detection);
    QString msg = doc.toJson(QJsonDocument::Compact);
    for (QWebSocket *pClient : std::as_const(m_clients)) {
        pClient->sendTextMessage(msg);
    }
}

void WebsocketMgr::broadcastStatus(const QJsonObject& status)
{
    QJsonDocument doc(status);
    QString msg = doc.toJson(QJsonDocument::Compact);
    for (QWebSocket *pClient : std::as_const(m_clients)) {
        pClient->sendTextMessage(msg);
    }
}

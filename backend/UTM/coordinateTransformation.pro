TEMPLATE = app
TARGET = name_of_the_app

QT = core gui

greaterThan(QT_MAJOR_VERSION, 4): QT += widgets

SOURCES += \
    coordinate_transformation.cpp \
    tools/src/UTM.cpp

HEADERS += \
    tools/include/UTM.h

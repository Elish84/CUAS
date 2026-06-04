#include <QApplication>
#include <QCoreApplication>
#include <iostream>
#include <string>
#include <signal.h>
#include <Builder/Builder.h>
#include <QDebug>


enum CommandLineArgumentsEnum
{
    CMDL_ARG_PROGRAM     = 0,
    CMDL_ARG_MODULES     = 1,
};

void onExit(int sig)
{
//    pBuilder->slot_Exit();
}

int main(int argc, char *argv[])
{
    QCoreApplication::setApplicationVersion(QString(APP_VERSION));

#ifndef linux
    QApplication app(argc, argv);
#else
    QCoreApplication app(argc, argv);
#endif

    std::cout << "--------------------------------------------------------------" << std::endl;
    std::cout << "--       RADAR                                                " << std::endl;
    std::cout << "--------------------------------------------------------------" << std::endl << std::endl;

    signal(SIGINT, onExit);

    if(argc < 2)
    {
        std::cout << "Set command line argument to radar folder" << std::endl;
        std::cout << "Set working directory to radar/bin folder" << std::endl;
        exit(1);
    }

    Builder* pBuilder = new Builder(app.arguments().at(1));

    pBuilder->BuildFiles("");

    pBuilder->BuildConstructors();
    pBuilder->Initialize();
    pBuilder->Run();

    app.exec();


    delete pBuilder;

    return 0;
}

const net = require('net');

const client = new net.Socket();
const ip = '192.168.168.102';
const port = 23;

client.connect(port, ip, () => {
    console.log(`Connected to ${ip}:${port}`);
    
    // Send basic SCPI commands
    client.write("*IDN?\r\n");
    
    setTimeout(() => {
        client.write("MODE:SWT:START\r\n");
    }, 1000);
});

client.on('data', (data) => {
    console.log(`[RADAR] ${data.toString()}`);
});

client.on('close', () => {
    console.log('Connection closed');
});

client.on('error', (err) => {
    console.error('Error:', err.message);
});

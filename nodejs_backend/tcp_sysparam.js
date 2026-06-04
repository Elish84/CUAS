const net = require('net');

const client = new net.Socket();
const ip = '192.168.168.102';
const port = 23;

client.connect(port, ip, () => {
    console.log(`Connected to ${ip}:${port}`);
    client.write("SYSPARAM?\r\n");
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

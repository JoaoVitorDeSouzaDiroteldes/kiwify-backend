const { Queue } = require('bullmq');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const downloadQueue = new Queue('download-queue', {
  connection: { host: REDIS_HOST, port: REDIS_PORT }
});

async function clean() {
    console.log('Conectando ao Redis em', REDIS_HOST, REDIS_PORT);
    console.log('Limpando fila...');
    
    await downloadQueue.pause();
    
    await Promise.all([
        downloadQueue.clean(0, 0, 'active'),
        downloadQueue.clean(0, 0, 'wait'),
        downloadQueue.clean(0, 0, 'delayed'),
        downloadQueue.clean(0, 0, 'paused'),
        downloadQueue.clean(0, 0, 'failed')
    ]);
    
    await downloadQueue.drain();
    
    // Opcional: tentar limpar completamente
    // await downloadQueue.obliterate({ force: true });
    
    console.log('Fila limpa com sucesso!');
    process.exit(0);
}

clean().catch(e => {
    console.error('Erro:', e);
    process.exit(1);
});

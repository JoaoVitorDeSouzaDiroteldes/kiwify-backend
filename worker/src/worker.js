const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

console.log('Iniciando Worker...');

// Diagnóstico de ambiente na inicialização
try {
  const ls = spawn('ls', ['-l', '/usr/local/bin/kiwifyDownload']);
  ls.stdout.on('data', d => console.log('Check binário:', d.toString().trim()));
  ls.stderr.on('data', d => console.log('Check binário erro:', d.toString().trim()));
  
  const help = spawn('kiwifyDownload', ['--help']);
  help.stdout.on('data', d => console.log('Check help stdout:', d.toString().trim()));
  help.stderr.on('data', d => console.log('Check help stderr:', d.toString().trim()));
} catch (e) {
  console.error('Erro no diagnóstico:', e);
}

const worker = new Worker('download-queue', async job => {
  // Extrai o nome do curso, suportando tanto o formato transformado quanto o raw da Kiwify
  const courseName = job.data.courseName || (job.data.course && job.data.course.name) || 'Curso_Desconhecido';
  
  console.log(`[Job ${job.id}] Processando download do curso: ${courseName}`);
  
  const courseNameSafe = courseName.replace(/[^a-zA-Z0-9]/g, '_');
  const tempJsonPath = path.join(__dirname, `../temp/${courseNameSafe}_${job.id}.json`);
  const outputDir = path.join(__dirname, `../downloads/${courseNameSafe}`);

  // 1. Salvar JSON em arquivo temporário
  try {
    if (!fs.existsSync(path.dirname(tempJsonPath))) {
        fs.mkdirSync(path.dirname(tempJsonPath), { recursive: true });
    }
    fs.writeFileSync(tempJsonPath, JSON.stringify(job.data, null, 2));
    console.log(`[Job ${job.id}] JSON salvo em: ${tempJsonPath}`);
  } catch (err) {
    console.error(`[Job ${job.id}] Erro ao salvar JSON:`, err);
    throw err;
  }

  // 2. Executar o binário kiwifyDownload
  // O binário está em /usr/local/bin/kiwifyDownload (definido no Dockerfile)
  return new Promise((resolve, reject) => {
    console.log(`[Job ${job.id}] Iniciando kiwifyDownload...`);
    console.log(`[Job ${job.id}] Input: ${tempJsonPath}`);
    console.log(`[Job ${job.id}] Output: ${outputDir}`);
    
    // Cria diretório de saída se não existir
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Correção: O binário espera argumentos nomeados (--jsonPath e --output)
    const child = spawn('kiwifyDownload', [
        `--jsonPath=${tempJsonPath}`, 
        `--output=${outputDir}`
    ]);
    
    child.stdout.on('data', (data) => {
      console.log(`[Job ${job.id}]: ${data.toString().trim()}`);
    });

    child.stderr.on('data', (data) => {
      // O ffmpeg e o downloader podem usar stderr para logs normais, então logamos mas não tratamos como erro fatal imediato
      console.log(`[Job ${job.id} LOG]: ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
      // Limpar arquivo temp JSON após execução
      try { fs.unlinkSync(tempJsonPath); } catch(e) {}

      if (code === 0) {
        console.log(`[Job ${job.id}] Download concluído com sucesso!`);
        resolve();
      } else {
        const errorMsg = `Processo saiu com código ${code}`;
        console.error(`[Job ${job.id}] ${errorMsg}`);
        reject(new Error(errorMsg));
      }
    });
    
    child.on('error', (err) => {
        console.error(`[Job ${job.id}] Falha ao iniciar processo:`, err);
        reject(err);
    });
  });

}, {
  connection: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
});

worker.on('completed', job => {
  console.log(`[Job ${job.id}] Completado com sucesso!`);
});

worker.on('failed', (job, err) => {
  console.error(`[Job ${job.id}] Falhou com erro: ${err.message}`);
});

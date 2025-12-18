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

const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');
const MIGRATIONS_FILE = path.join(DOWNLOADS_DIR, 'migrations.json');

const updateMigrationStatus = (workspaceId, courseId, data) => {
  if (!workspaceId || !courseId) return;
  if (!fs.existsSync(MIGRATIONS_FILE)) return;
  try {
    const migrations = JSON.parse(fs.readFileSync(MIGRATIONS_FILE, 'utf8'));
    const index = migrations.findIndex(m => m.workspaceId === workspaceId && m.courseId === courseId);
    if (index !== -1) {
      migrations[index] = { ...migrations[index], ...data, updatedAt: new Date().toISOString() };
      fs.writeFileSync(MIGRATIONS_FILE, JSON.stringify(migrations, null, 2));
    }
  } catch (e) {
    console.error('Erro ao atualizar status da migração:', e);
  }
};

const worker = new Worker('download-queue', async job => {
  const { workspaceId, courseId } = job.data;
  const courseName = job.data.courseName || (job.data.course && job.data.course.name) || 'Curso_Desconhecido';
  
  console.log(`[Job ${job.id}] Processando download do curso: ${courseName} (Workspace: ${workspaceId || 'N/A'})`);
  
  const courseNameSafe = courseName.replace(/[^a-zA-Z0-9]/g, '_');
  const tempJsonPath = path.join(__dirname, `../temp/${courseNameSafe}_${job.id}.json`);
  
  // Define diretório de saída baseado no Workspace se fornecido
  const outputDir = workspaceId 
    ? path.join(DOWNLOADS_DIR, `workspaces/${workspaceId}/${courseId || courseNameSafe}`)
    : path.join(DOWNLOADS_DIR, courseNameSafe);

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
        if (workspaceId && courseId) {
          updateMigrationStatus(workspaceId, courseId, { status: 'completed', progress: 100 });
        }
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
  const { workspaceId, courseId } = job.data;
  if (workspaceId && courseId) {
    updateMigrationStatus(workspaceId, courseId, { status: 'error', error: err.message });
  }
});

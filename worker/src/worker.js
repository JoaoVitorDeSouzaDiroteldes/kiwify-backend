const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { Storage } = require('@google-cloud/storage');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Caminho absoluto para o diretório de downloads no Docker
const DOWNLOADS_DIR = '/app/downloads';

console.log(`Configurando diretório de downloads: ${DOWNLOADS_DIR}`);

// Garante que o diretório existe antes de tentar abrir o banco
try {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    console.log(`Criando diretório de downloads: ${DOWNLOADS_DIR}`);
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } else {
    console.log(`Diretório de downloads já existe: ${DOWNLOADS_DIR}`);
  }
} catch (e) {
  console.error(`Erro ao criar diretório ${DOWNLOADS_DIR}:`, e);
}

const dbPath = path.join(DOWNLOADS_DIR, 'bridge.db');
console.log(`Abrindo banco de dados em: ${dbPath}`);
const db = new Database(dbPath);

const storage = new Storage();
const BUCKET_NAME = 'kiwify-content-platform';

console.log('Iniciando Worker...');

/**
 * Faz upload recursivo de uma pasta para o GCS
 */
async function uploadFolderToGCS(localPath, remotePrefix) {
    const files = fs.readdirSync(localPath, { withFileTypes: true });
    
    for (const file of files) {
        const fullLocalPath = path.join(localPath, file.name);
        const fullRemotePath = `${remotePrefix}/${file.name}`;
        
        if (file.isDirectory()) {
            await uploadFolderToGCS(fullLocalPath, fullRemotePath);
        } else {
            console.log(`[GCS] Fazendo upload: ${fullRemotePath}`);
            await storage.bucket(BUCKET_NAME).upload(fullLocalPath, {
                destination: fullRemotePath,
                public: true,
                metadata: {
                    cacheControl: 'public, max-age=31536000',
                }
            });
        }
    }
}

const updateMigrationStatus = (workspaceId, courseId, data) => {
  if (!workspaceId || !courseId) return;
  try {
    const stmt = db.prepare(`
      UPDATE migrations 
      SET status = ?, progress = ?, error = ?, updatedAt = CURRENT_TIMESTAMP 
      WHERE workspaceId = ? AND courseId = ?
    `);
    stmt.run(data.status, data.progress || 0, data.error || null, workspaceId, courseId);
  } catch (e) {
    console.error('Erro ao atualizar status no SQLite:', e);
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
    // Usando caminho absoluto para evitar ENOENT
    const child = spawn('/usr/local/bin/kiwifyDownload', [
        `--jsonPath=${tempJsonPath}`, 
        `--output=${outputDir}`
    ]);
    
    let totalLessons = 0;
    let completedLessons = 0;

    // Tenta estimar o total de lições do job data
    if (job.data.course && job.data.course.modules) {
      totalLessons = job.data.course.modules.reduce((acc, mod) => acc + (mod.lessons ? mod.lessons.length : 0), 0);
    }

    child.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[Job ${job.id}]: ${output.trim()}`);
      
      // Monitora progresso por mensagens do binário (heurística baseada no log)
      if (output.includes('Starting download of')) {
          // Incrementa progresso logico
          completedLessons++;
          if (totalLessons > 0) {
              const progress = Math.min(Math.round((completedLessons / totalLessons) * 90), 95); // Reserva 5% para o upload
              updateMigrationStatus(workspaceId, courseId, { status: 'downloading', progress });
          }
      }
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      // O ffmpeg e o downloader podem usar stderr para logs normais
      if (!output.includes('frame=') && !output.includes('bitrate=')) {
          console.log(`[Job ${job.id} LOG]: ${output.trim()}`);
      }
    });

    child.on('close', (code) => {
      // Limpar arquivo temp JSON após execução
      try { fs.unlinkSync(tempJsonPath); } catch(e) {}

      if (code === 0) {
        console.log(`[Job ${job.id}] Download concluído com sucesso! Iniciando upload para GCS...`);
        
        const remotePrefix = workspaceId 
            ? `workspaces/${workspaceId}/${courseId || courseNameSafe}`
            : courseNameSafe;

        uploadFolderToGCS(outputDir, remotePrefix)
            .then(() => {
                console.log(`[Job ${job.id}] Upload para GCS concluído!`);
                if (workspaceId && courseId) {
                    updateMigrationStatus(workspaceId, courseId, { 
                        status: 'completed', 
                        progress: 100,
                        remoteUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${remotePrefix}`
                    });
                }
                resolve();
            })
            .catch(err => {
                console.error(`[Job ${job.id}] Erro no upload para GCS:`, err);
                reject(err);
            });
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

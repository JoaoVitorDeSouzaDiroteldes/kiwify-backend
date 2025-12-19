const { Worker, Queue } = require('bullmq');
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

const downloadQueue = new Queue('download-queue', { connection: { host: REDIS_HOST, port: REDIS_PORT } });

async function clearStaleJobs() {
  try {
    console.log('Limpando a fila de downloads para remover jobs antigos...');
    await downloadQueue.clean(0, 'active');
    await downloadQueue.clean(0, 'wait');
    await downloadQueue.clean(0, 'paused');
    console.log('Fila limpa com sucesso.');
  } catch (e) {
    console.error('Erro ao limpar a fila:', e);
  }
}

/**
 * Faz upload recursivo de uma pasta para o GCS. Retorna uma promessa.
 */
function uploadFolderToGCS(localPath, remotePrefix) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(localPath)) {
            console.warn(`[GCS] Diretório local não encontrado para upload: ${localPath}`);
            return resolve(); // Resolve para não quebrar a cadeia se a pasta não existir
        }

        const files = fs.readdirSync(localPath, { withFileTypes: true });
        const uploadPromises = files.map(file => {
            const fullLocalPath = path.join(localPath, file.name);
            const fullRemotePath = `${remotePrefix}/${file.name}`;
            
            if (file.isDirectory()) {
                return uploadFolderToGCS(fullLocalPath, fullRemotePath);
            } else {
                console.log(`[GCS] Fazendo upload: ${fullRemotePath}`);
                return storage.bucket(BUCKET_NAME).upload(fullLocalPath, {
                    destination: fullRemotePath,
                    public: true,
                    metadata: {
                        cacheControl: 'public, max-age=31536000',
                    }
                });
            }
        });

        Promise.all(uploadPromises).then(resolve).catch(reject);
    });
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
    let currentModuleDir = '';
    let previousLessonDir = '';

    const escapeFs = (s) => s ? s.replace(/[^a-zA-Z0-9.\-]/g, '_') : '';

    // Tenta estimar o total de lições do job data
    if (job.data.course && job.data.course.modules) {
      totalLessons = job.data.course.modules.reduce((acc, mod) => acc + (mod.lessons ? mod.lessons.length : 0), 0);
    }
    
    const triggerIncrementalUpload = () => {
        if (currentModuleDir && previousLessonDir) {
            const lessonPathToUpload = path.join(outputDir, currentModuleDir, previousLessonDir);
            const courseRemoteDir = workspaceId 
                ? `workspaces/${workspaceId}/${courseId || courseNameSafe}`
                : courseNameSafe;
            const remotePrefix = `${courseRemoteDir}/${currentModuleDir}/${previousLessonDir}`;
            
            console.log(`[UPLOAD INCREMENTAL] Upload da lição anterior: ${remotePrefix}`);
            uploadFolderToGCS(lessonPathToUpload, remotePrefix)
                .then(() => {
                    fs.writeFileSync(path.join(lessonPathToUpload, '.uploaded'), 'true');
                    console.log(`[UPLOAD INCREMENTAL] Sucesso para: ${remotePrefix}`);
                })
                .catch(err => console.error(`[UPLOAD INCREMENTAL] Falha para: ${remotePrefix}`, err));
        }
    };

    child.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[Job ${job.id}]: ${output.trim()}`);

        const moduleMatch = output.match(/Module '(.+)'/);
        if (moduleMatch) {
            triggerIncrementalUpload(); // Upload a última aula do módulo anterior
            currentModuleDir = moduleMatch[1];
            previousLessonDir = '';
        }

        const lessonMatch = output.match(/Starting download of '(.+)'/);
        if (lessonMatch) {
            triggerIncrementalUpload(); // Upload da aula anterior
            previousLessonDir = lessonMatch[1];
            
            // Atualiza progresso
            completedLessons++;
            if (totalLessons > 0) {
                const progress = Math.min(Math.round((completedLessons / totalLessons) * 95), 95);
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
      try { fs.unlinkSync(tempJsonPath); } catch(e) {}

      if (code === 0) {
        console.log(`[Job ${job.id}] Processo de download finalizado.`);
        // Dispara o upload da última aula processada
        triggerIncrementalUpload();
        
        // Dá um pequeno tempo para o último upload ser registrado antes de finalizar.
        setTimeout(() => {
            console.log(`[Job ${job.id}] Migração concluída.`);
            if (workspaceId && courseId) {
                const remotePrefix = workspaceId ? `workspaces/${workspaceId}/${courseId || courseNameSafe}` : courseNameSafe;
                updateMigrationStatus(workspaceId, courseId, { 
                    status: 'completed', 
                    progress: 100,
                    remoteUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${remotePrefix}`
                });
            }
            resolve();
        }, 5000); // Espera 5 segundos

      } else {
        const errorMsg = `Processo de download saiu com código ${code}`;
        console.error(`[Job ${job.id}] ${errorMsg}`);
        if (workspaceId && courseId) {
            updateMigrationStatus(workspaceId, courseId, { status: 'error', error: errorMsg });
        }
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

// Limpa a fila ao iniciar e então começa a escutar por jobs
clearStaleJobs().then(() => {
    console.log('Worker pronto para processar jobs.');
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

/**
 * Tenta encontrar o array de aulas dentro de um objeto de módulo da Kiwify.
 * A API pode usar chaves diferentes como 'lessons', 'items', 'contents', etc.
 */
function findLessonsArray(module) {
    if (!module) return [];
    if (Array.isArray(module.lessons) && module.lessons.length > 0) return module.lessons;
    if (Array.isArray(module.items) && module.items.length > 0) return module.items;

    // Busca recursiva por qualquer array que contenha objetos com 'title' e 'video'
    for (const key in module) {
        if (Array.isArray(module[key])) {
            const firstItem = module[key][0];
            if (firstItem && typeof firstItem === 'object' && 'title' in firstItem && 'video' in firstItem) {
                console.log(`Encontrado array de aulas na chave: "${key}"`);
                return module[key];
            }
        }
    }
    return [];
}


/**
 * Transforma o JSON da API da Kiwify para o formato do kiwifyDownload.
 */
function transformKiwifyToDownloaderFormat(kiwifyData) {
  if (!kiwifyData || !kiwifyData.course || !kiwifyData.class) {
    throw new Error('Formato de dados da Kiwify inválido. Faltando "course" ou "class".');
  }

  const courseName = kiwifyData.course.name;

  // A API da Kiwify retorna os módulos dentro da chave 'course.modules'
  // (Baseado no modelo real JMI/course.json)
  const modulesSource = kiwifyData.course.modules || kiwifyData.modules || kiwifyData.class || [];
  
  const modules = modulesSource.map(kiwifyModule => {
    const rawLessons = findLessonsArray(kiwifyModule);
    console.log(`Processando módulo "${kiwifyModule.name}". Aulas encontradas: ${rawLessons.length}`);

    const lessons = rawLessons.map(kiwifyLesson => {
      return {
        lessonName: kiwifyLesson.title,
        videoUrl: kiwifyLesson.video ? kiwifyLesson.video.download_link : null,
        attachments: (kiwifyLesson.files || []).map(file => ({
          fileName: file.name,
          url: file.url,
        })),
      };
    });

    return {
      moduleName: kiwifyModule.name,
      lessons: lessons,
    };
  });

  const result = { courseName, modules };
  
  const totalLessons = result.modules.reduce((acc, mod) => acc + mod.lessons.length, 0);
  console.log(`Transformação concluída. Total de módulos: ${result.modules.length}, Total de aulas: ${totalLessons}`);
  
  return result;
}

module.exports = {
  transformKiwifyToDownloaderFormat,
};

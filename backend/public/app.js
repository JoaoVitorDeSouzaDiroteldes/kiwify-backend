document.addEventListener('DOMContentLoaded', () => {
    // --- ELEMENTOS DO DOM ---
    const tokenInput = document.getElementById('token-input');
    const btnListCourses = document.getElementById('btn-list-courses');
    const coursesList = document.getElementById('courses-list');
    const galleryList = document.getElementById('gallery-list');
    const playerSection = document.getElementById('player-section');
    const playerVideo = document.getElementById('player-video');
    const playerTitle = document.getElementById('player-title');
    const playerPlaylist = document.getElementById('player-playlist');
    const btnBackToGallery = document.getElementById('btn-back-to-gallery');

    // --- ESTADO DA APLICAÇÃO ---
    let userToken = '';
    const API_URL = 'http://34.41.10.145:3001';

    // --- FUNÇÕES DE LÓGICA ---

    // 1. Listar Cursos da Kiwify para Download
    async function listCoursesForDownload() {
        userToken = tokenInput.value.trim();
        if (!userToken) {
            alert('Por favor, insira o token.');
            return;
        }

        btnListCourses.disabled = true;
        btnListCourses.textContent = 'Carregando...';
        coursesList.innerHTML = '<p class="loading">Buscando cursos na Kiwify...</p>';

        try {
            const response = await fetch(`${API_URL}/courses`, {
                headers: { 'Authorization': `Bearer ${userToken}` }
            });
            if (!response.ok) throw new Error(`Erro na API: ${response.statusText}`);
            
            const courses = await response.json();
            renderCoursesForDownload(courses);
        } catch (error) {
            coursesList.innerHTML = `<p class="error">Erro ao listar cursos: ${error.message}</p>`;
        } finally {
            btnListCourses.disabled = false;
            btnListCourses.textContent = 'Listar Cursos';
        }
    }

    // 2. Renderizar Cursos para Download
    function renderCoursesForDownload(courses) {
        if (courses.length === 0) {
            coursesList.innerHTML = '<p>Nenhum curso encontrado.</p>';
            return;
        }
        coursesList.innerHTML = courses.map(course => `
            <div class="card">
                <img src="${course.cover_image}" alt="${course.name}">
                <div class="card-content">
                    <h3 title="${course.name}">${course.name}</h3>
                    <button onclick="window.prepareDownload('${course.id}', '${course.name.replace(/'/g, "\\'")}')">Baixar na VM</button>
                </div>
            </div>
        `).join('');
    }

    // 3. Iniciar Download (disponível globalmente para onclick)
    window.prepareDownload = async (courseId, courseName) => {
        if (!userToken) {
            alert('Token não encontrado. Liste os cursos novamente.');
            return;
        }
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Enviando...';

        try {
            await fetch(`${API_URL}/courses/${courseId}/prepare-download`, {
                headers: { 'Authorization': `Bearer ${userToken}` }
            });
            alert(`"${courseName}" foi enviado para a fila de download! Atualize a galeria em alguns minutos.`);
            btn.textContent = 'Solicitado!';
        } catch (error) {
            alert(`Erro ao iniciar download: ${error.message}`);
            btn.disabled = false;
            btn.textContent = 'Baixar na VM';
        }
    };
    
    // 4. Carregar Cursos da Galeria Local
    async function loadGallery() {
        galleryList.innerHTML = '<p class="loading">Carregando galeria da VM...</p>';
        try {
            const response = await fetch(`${API_URL}/gallery`);
            if (!response.ok) throw new Error(`Erro na API: ${response.statusText}`);

            const courses = await response.json();
            renderGallery(courses);
        } catch (error) {
            galleryList.innerHTML = `<p class="error">Erro ao carregar galeria: ${error.message}</p>`;
        }
    }

    // 5. Renderizar Galeria
    function renderGallery(courses) {
        if (courses.length === 0) {
            galleryList.innerHTML = '<p>Nenhum curso baixado ainda. Use a seção acima para baixar.</p>';
            return;
        }
        galleryList.innerHTML = courses.map(item => `
            <div class="card gallery-card" onclick="window.openCoursePlayer('${encodeURIComponent(JSON.stringify(item))}')">
                <img src="${item.course.config.premium_members_area.cover_image_desktop}" alt="${item.course.name}">
                <div class="card-content">
                    <h3 title="${item.course.name}">${item.course.name}</h3>
                    <p>${item.course.modules.length} módulos</p>
                </div>
            </div>
        `).join('');
    }

    // 6. Abrir Player do Curso (disponível globalmente)
    window.openCoursePlayer = (encodedCourse) => {
        const courseItem = JSON.parse(decodeURIComponent(encodedCourse));
        document.querySelector('main').style.display = 'none';
        playerSection.style.display = 'flex';

        playerTitle.textContent = courseItem.course.name;
        renderPlaylist(courseItem);
    };

    // 7. Renderizar Playlist
    function renderPlaylist(courseItem) {
        playerPlaylist.innerHTML = courseItem.course.modules.map(module => `
            <div class="module">
                <h4>${module.name}</h4>
                <div class="lessons">
                    ${module.lessons.map((lesson, lessonIndex) => {
                        if (!lesson.video) return ''; // Ignora aulas sem vídeo
                        const videoUrl = `${API_URL}/content/${courseItem.dirName}/${module.order}_${sanitize(module.name)}/${lessonIndex}_${sanitize(lesson.title)}/${lesson.video.name}`;
                        return `<a href="#" onclick="window.playVideo('${videoUrl}')">${lesson.title}</a>`;
                    }).join('')}
                </div>
            </div>
        `).join('');
    }

    // 8. Tocar Vídeo (disponível globalmente)
    window.playVideo = (url) => {
        event.preventDefault();
        playerVideo.src = url;
        playerVideo.play();
    };
    
    // 9. Voltar para a Galeria
    btnBackToGallery.addEventListener('click', () => {
        playerVideo.pause();
        playerVideo.src = '';
        playerSection.style.display = 'none';
        document.querySelector('main').style.display = 'block';
        loadGallery(); // Recarrega a galeria
    });

    // --- FUNÇÕES AUXILIARES ---
    const sanitize = (s) => s ? s.replace(/[^a-zA-Z0-9]/g, '_') : '';


    // --- INICIALIZAÇÃO ---
    btnListCourses.addEventListener('click', listCoursesForDownload);
    loadGallery(); // Carrega a galeria ao iniciar
});

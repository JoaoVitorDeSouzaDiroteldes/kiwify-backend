const axios = require('axios');

const API_BASE_URL = 'https://admin-api.kiwify.com.br/v1';

/**
 * Cria a configuração de headers com o token de autorização e headers extras
 * para emular um navegador real, conforme fornecido pelo usuário.
 * @param {string} token - O access_token do usuário.
 * @returns {object} - Objeto de headers para o Axios.
 */
const getAuthHeaders = (token) => ({
  headers: {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/plain, */*',
  },
});

/**
 * Busca a lista de cursos de um usuário na Kiwify.
 * @param {string} token - O access_token do usuário.
 * @returns {Promise<Array>} - Uma promessa que resolve para a lista de cursos.
 */
async function listCourses(token) {
  try {
    // Remove if-none-match para forçar 200 OK em vez de 304 Not Modified na listagem
    const headers = getAuthHeaders(token);
    delete headers.headers['if-none-match'];

    const response = await axios.get(`${API_BASE_URL}/viewer/schools/courses`, headers);
    
    const rawCourses = response.data.courses || [];

    const mappedCourses = rawCourses.map(item => {
      const info = item.course_info || item;
      return {
        id: info.id,
        name: info.name,
        cover_image: info.course_img || info.cover_image,
        product_id: item.product_id 
      };
    });

    console.log('Cursos mapeados:', JSON.stringify(mappedCourses, null, 2));
    return mappedCourses;
  } catch (error) {
    console.error('Erro ao listar cursos:', error.response ? error.response.data : error.message);
    throw new Error('Não foi possível buscar os cursos na Kiwify.');
  }
}

/**
 * Busca a estrutura completa de um curso específico.
 */
async function getCourseSections(courseId, token) {
  if (!courseId) {
    throw new Error('O ID do curso é obrigatório.');
  }
  try {
    const response = await axios.get(`${API_BASE_URL}/viewer/courses/${courseId}/sections`, getAuthHeaders(token));
    
    // Log para debug da estrutura retornada
    console.log(`Dados recebidos para curso ${courseId}:`, JSON.stringify(response.data).substring(0, 500) + '...');
    
    return response.data;
  } catch (error) {
    console.error(`Erro ao buscar seções do curso ${courseId}:`, error.response ? error.response.data : error.message);
    throw new Error('Não foi possível buscar a estrutura do curso na Kiwify.');
  }
}

module.exports = {
  listCourses,
  getCourseSections,
};

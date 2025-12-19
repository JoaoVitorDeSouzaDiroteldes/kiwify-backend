# 📘 Guia de Integração Frontend V6: Fluxo Sólido & Streaming

**Versão:** 6.1 (Atualizado com Ferramentas Adm)
**Data:** 19/12/2025
**Status:** Obrigatório

Este guia detalha como integrar com o novo **Fluxo de Migração Atômica** e as novas **Ferramentas de Gerenciamento** do Backend.

---

## 1. 🚨 Mudança Crítica: A "Regra de Ouro"

Para resolver problemas de vídeos que não carregavam, implementamos uma consistência estrita no backend.

> **Regra de Ouro:**
> O campo `isMigrated` só será `true` quando o vídeo já estiver salvo no GCS e sua URL final (`streamUrl`) estiver gravada no banco de dados.

**O que isso significa para o Frontend:**
*   **PARE** de tentar "adivinhar" URLs ou construir caminhos manualmente.
*   **USE** apenas a URL fornecida no campo `video.streamUrl`.
*   Se `isMigrated` for `false`, exiba um estado de "Processando" ou "Aguardando", mas **não renderize o player**.

---

## 2. 🔌 Atualização da Bridge API (`src/services/bridgeApi.ts`)

Atualize seu serviço para refletir os novos tipos de dados e funcionalidades administrativas.

### Novos Tipos TypeScript

```typescript
// src/types.ts

export type ProcessingStatus = 'idle' | 'processing' | 'completed' | 'error';

export interface KiwifyLesson {
  id: string;
  title: string;
  // ... outros campos
  
  // NOVOS CAMPOS V6
  isMigrated: boolean;          // Use isso para decidir se mostra o player
  processingStatus: ProcessingStatus; // Use isso para mostrar loaders/erros
  video?: {
    name: string;
    streamUrl?: string;         // URL direta do GCS (https://storage.googleapis.com/...)
    duration?: number;
  };
}
```

### Método `getGallery`

O endpoint `/gallery` é sua fonte da verdade. Ele já retorna os dados formatados corretamente.

```typescript
// src/services/bridgeApi.ts

  async getGallery(): Promise<any[]> {
    const res = await fetch(`${CONFIG.KIWIFY_API_URL}/gallery`, {
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Erro ao carregar galeria');
    return res.json();
  }
```

---

## 3. 🛡️ Ferramentas Administrativas (Novo na V6.1)

Adicione estas funções à `bridgeApi` para permitir o gerenciamento da fila de downloads. Ideal para telas de "Configurações" ou "Admin".

### Limpar Fila (`clearQueue`)

Remove todos os downloads pendentes, em espera ou falhos. Útil se a fila travar ou ficar muito cheia.

```typescript
  /**
   * Limpa a fila de downloads e cancela processos pendentes.
   */
  async clearQueue(): Promise<{ success: boolean; cancelledMigrations: number }> {
    const res = await fetch(`${CONFIG.KIWIFY_API_URL}/queue`, {
      method: 'DELETE',
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Erro ao limpar a fila');
    return res.json();
  },
```

### Cancelar Curso (`cancelCourse`)

Interrompe a migração de um curso específico.

```typescript
  /**
   * Cancela a migração de um curso específico.
   */
  async cancelCourse(workspaceId: string, courseId: string): Promise<void> {
    const res = await fetch(`${CONFIG.KIWIFY_API_URL}/migrations/${workspaceId}/${courseId}`, {
      method: 'DELETE',
      headers: getHeaders()
    });
    if (!res.ok && res.status !== 404) throw new Error('Erro ao cancelar curso');
  }
```

---

## 4. 🎥 Implementação do Player de Vídeo

A lógica de renderização do componente de aula (`LessonPlayer.tsx`) deve ser simplificada:

```tsx
// Exemplo Conceitual (React)

const LessonPlayer = ({ lesson }: { lesson: KiwifyLesson }) => {
  
  // 1. Estado de Erro
  if (lesson.processingStatus === 'error') {
    return (
      <div className="error-banner">
        Erro ao processar vídeo. 
        <button onClick={handleRetry}>Tentar Novamente</button>
      </div>
    );
  }

  // 2. Estado de Processamento (Download/Upload em andamento)
  if (lesson.processingStatus === 'processing' || (lesson.processingStatus === 'idle' && !lesson.isMigrated)) {
    return (
      <div className="processing-state">
        <Spinner />
        <p>Otimizando vídeo para streaming...</p>
      </div>
    );
  }

  // 3. Estado Pronto (Stream GCS)
  if (lesson.isMigrated && lesson.video?.streamUrl) {
    return (
      <video controls width="100%" poster={lesson.thumbnail}>
        <source src={lesson.video.streamUrl} type="video/mp4" />
        Seu navegador não suporta vídeos.
      </video>
    );
  }

  return <div>Conteúdo indisponível ou aguardando início da migração.</div>;
};
```

**Benefícios:**
*   Zero erros de 404 no console.
*   Experiência de usuário fluida (loading real).
*   Garantia de que o vídeo vai tocar se o player aparecer.

---

## 5. 📊 Monitoramento de Progresso

Para acompanhar o progresso global de um curso (barra de porcentagem), continue usando o endpoint de status do workspace:

*   **Endpoint:** `GET /workspaces/:id/status`
*   **Retorno:** Lista de migrações com campo `progress` (0-100).
*   **Comportamento:** O progresso sobe conforme as aulas são baixadas e enviadas. Quando chega a 100%, todas as aulas daquele curso devem estar com `isMigrated: true` na galeria.

---

## 6. ❓ FAQ & Troubleshooting

**Q: O download terminou (100%), mas a aula ainda não aparece no player.**
**R:** Isso é normal. O "100%" refere-se ao download para o servidor. O `isMigrated: true` só ativa após o upload para o GCS. Pode haver um pequeno delay (segundos) entre o 100% e a disponibilidade do vídeo. Implemente um *polling* suave na galeria se necessário.

**Q: O que fazer se `processingStatus` for `error`?**
**R:** Exiba um botão de "Tentar Novamente" que chama o endpoint `/courses/migrate` novamente para o mesmo curso. O sistema é idempotente e tentará processar apenas o que falhou.

---
*Equipe de Backend Kiwify*

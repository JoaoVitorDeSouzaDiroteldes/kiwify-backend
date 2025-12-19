# 🛡️ Guia de Implementação: Ferramentas Administrativas V1

**Data:** 19/12/2025
**Contexto:** Gerenciamento de filas e cancelamento de migrações na Kiwify Platform.

Este documento fornece as especificações para a implementação de funcionalidades administrativas no Frontend, permitindo o controle sobre os processos de download em andamento.

---

## 1. Visão Geral

Foram disponibilizados dois novos endpoints na API do Backend para permitir:
1.  **Limpeza Total:** Parar todos os downloads e limpar a fila de processamento.
2.  **Cancelamento Seletivo:** Interromper a migração de um curso específico.

Estas funções devem ser restritas a usuários com permissão de administrador ou utilizadas em áreas de "Configurações Avançadas".

---

## 2. API Reference & Integração

Adicione os métodos abaixo ao seu serviço de comunicação com a API (ex: `bridgeApi.ts`).

### A. Limpar Fila de Downloads (`DELETE /queue`)

Este comando é "destrutivo". Ele remove todos os jobs da fila (pendentes, ativos, falhos) e marca as migrações em andamento como `cancelled` no banco de dados.

*   **Endpoint:** `DELETE /queue`
*   **Retorno Sucesso:** `200 OK` `{ success: true, message: "...", cancelledMigrations: 5 }`

**Exemplo de Implementação (TypeScript):**

```typescript
/**
 * Limpa toda a fila de downloads e cancela processos ativos.
 * Use com cautela.
 */
async function clearDownloadQueue(): Promise<void> {
  const token = localStorage.getItem('kiwify_token'); // Ou sua lógica de auth
  
  const response = await fetch('https://34-136-160-206.sslip.io/queue', {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error('Falha ao limpar a fila de downloads');
  }

  const data = await response.json();
  console.log(`Fila limpa! ${data.cancelledMigrations} migrações canceladas.`);
}
```

### B. Cancelar Migração Específica (`DELETE /migrations/:ws/:id`)

Cancela logicamente uma migração. Se o download estiver na fila, ele não será processado. Se estiver rodando, o status no banco será atualizado para `cancelled` (embora o processo atual possa terminar o download do arquivo corrente antes de parar).

*   **Endpoint:** `DELETE /migrations/:workspaceId/:courseId`
*   **Params:** `workspaceId` (UUID), `courseId` (UUID)

**Exemplo de Implementação:**

```typescript
async function cancelCourseMigration(workspaceId: string, courseId: string) {
  const response = await fetch(`https://34-136-160-206.sslip.io/migrations/${workspaceId}/${courseId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ...` }
  });

  if (!response.ok) {
    alert('Erro ao cancelar curso. Verifique se ele já não foi finalizado.');
  }
}
```

---

## 3. Sugestão de UI (Interface)

### Botão de Pânico (Limpar Fila)
Recomendamos colocar um botão na tela de **Dashboard** ou **Configurações**:

> **[ 🗑️ Limpar Fila de Downloads ]**
> *Ao clicar: Exibir confirmação "Tem certeza? Isso cancelará todos os downloads em andamento."*

### Botão de Cancelar no Card
No card de progresso do curso (onde aparece a barra de %), adicione um botão de "X" ou "Cancelar" que só aparece quando o status é `downloading` ou `pending`.

```tsx
// Exemplo React
{status === 'downloading' && (
  <button onClick={() => handleCancel(course.id)} title="Cancelar Download">
    🛑 Cancelar
  </button>
)}
```

---
*Equipe de Backend*

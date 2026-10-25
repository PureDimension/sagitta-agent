/** 多个工具共用的字段说明；校验由 DSH defineTool 执行。 */
export const projectIdParameter = {
  type: 'string', required: true, description: '项目 ID，从 project_list 或 project_create 取得。',
} as const;

export const taskIdParameter = {
  type: 'string', required: true, description: '任务号，以十进制字符串传入，从 task_list 或 task_create 取得。',
} as const;

export const descriptionParameter = {
  type: 'string', description: 'Markdown 说明，可记录目标、验收要求、交接信息和文件链接。',
} as const;

export const descriptionModeParameter = {
  type: 'string', enum: ['replace', 'append'],
  description: `
省略为 replace（整体替换）；
append 将 description 原样追加到末尾，需要换行时在文本中提供。
`,
} as const;

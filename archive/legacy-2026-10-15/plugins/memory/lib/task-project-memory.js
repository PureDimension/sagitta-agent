// task-system-v2 §5：认领成功后的项目记忆召回。
// 保持为纯客户端辅助，便于在没有 DSH peer runtime 的本地 smoke 中验证。

const PROJECT_MEMORY_RECALL_SIZE = 5;

function excerpt(value, max = 800) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + "\n…(截断，完整内容见服务端)" : text;
}

function projectMemoryStream(task) {
  return task?.stream === "personal-projects" ? "personal-projects" : "company-projects";
}

async function recallProjectMemory(client, task, signal) {
  const project = String(task?.project ?? "").trim();
  if (!project) return { entries: [], note: "" };
  const domain = `projects/${project}`;
  const data = await client.listEntries(
    projectMemoryStream(task),
    { page: 1, size: PROJECT_MEMORY_RECALL_SIZE, domain },
    signal
  );
  const entries = (data?.items || []).slice(0, PROJECT_MEMORY_RECALL_SIZE);
  const noteLines = entries.length === 0
    ? ["已召回项目记忆：", "- （暂无命中）"]
    : ["已召回项目记忆：", ...entries.map((entry) =>
      `- **${String(entry.id ?? "")}** ${excerpt(entry.content || entry.condition || "（无正文）")}`
    )];
  noteLines.push(`如需更多项目背景，可调用 memory_recall domain=${domain} 查询`);
  return { entries, note: noteLines.join("\n") };
}

export { PROJECT_MEMORY_RECALL_SIZE, projectMemoryStream, recallProjectMemory };

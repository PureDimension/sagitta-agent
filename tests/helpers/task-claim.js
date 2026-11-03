export async function taskClaimExists(
  database,
  taskId,
) {
  const { rowCount } = await database.query('SELECT 1 FROM task_claims WHERE task_id = $1', [taskId]);
  return rowCount === 1;
}

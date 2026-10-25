/** Repository 仅在成功时返回数据，归档和缺失只返回标记。 */
export type RepositoryResult<T> =
  | { state: 'found'; value: T }
  | { state: 'archived' }
  | { state: 'missing' };

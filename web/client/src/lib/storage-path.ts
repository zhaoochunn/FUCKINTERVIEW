/** 存储路径的小工具：模型目录默认放在数据目录的 models/ 下。 */
const windowsPath = (value: string) => /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value);

export function modelsDirFor(dataDir: string): string {
  const trimmed = windowsPath(dataDir)
    ? dataDir.replace(/[\\/]+$/, "") : dataDir.replace(/\/+$/, "");
  const separator = windowsPath(dataDir) && trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}models`;
}

export function samePath(left: string, right: string): boolean {
  // Only Windows paths are case-folded. APFS can be case-sensitive, and a
  // backslash is a valid POSIX filename character.
  const normalize = (value: string) => windowsPath(value)
    ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : value.replace(/\/+$/, "") || (value.startsWith("/") ? "/" : "");
  return normalize(left) === normalize(right);
}

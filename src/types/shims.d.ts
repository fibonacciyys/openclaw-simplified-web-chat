declare module "markdown-it-task-lists" {
  // The package ships no types; minimal declaration for the plugin signature.
  const plugin: (md: import("markdown-it").default, options?: Record<string, unknown>) => void;
  export default plugin;
}

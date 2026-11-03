// Deliberately small task implementation shared by the web app and its API.
export function createTodos({ broken = false } = {}) {
  const items = [];
  return {
    list: () => items.map((item) => ({ ...item })),
    add(title) {
      if (typeof title !== "string" || (!broken && !title.trim())) {
        return { status: 400, body: { error: "A title is required" } };
      }
      const item = { id: items.length + 1, title: title.trim() };
      items.push(item);
      return { status: 201, body: item };
    },
  };
}

import { describe, expect, it } from "vitest";
import { addTodos, createTodoState, updateTodo } from "../state.ts";
import { MAX_WIDGET_ITEMS, renderWidgetLines } from "../widget.ts";

function theme() {
  return { fg: (color: string, text: string) => `${color}:${text}` } as any;
}

describe("widget de tarefas", () => {
  it("mostra cinco tarefas e o restante", () => {
    const state = addTodos(createTodoState(), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]).state;
    const lines = renderWidgetLines(state, theme(), 80);
    expect(lines).toHaveLength(MAX_WIDGET_ITEMS + 1);
    expect(lines.map((line) => line.includes("text:")).filter(Boolean)).toHaveLength(5);
    expect(lines.at(-1)).toBe("dim:+ 5 todos");
  });

  it("desliza após concluir a primeira tarefa", () => {
    let state = addTodos(createTodoState(), ["1", "2", "3", "4", "5", "6"]).state;
    state = updateTodo(state, 1, "done").state;
    const lines = renderWidgetLines(state, theme(), 80);
    expect(lines.join("\n")).not.toContain("text:1");
    expect(lines.join("\n")).toContain("text:2");
    expect(lines.join("\n")).toContain("text:6");
    expect(lines.some((line) => line.includes("todos"))).toBe(false);
  });

  it("não renderiza nada sem tarefas", () => {
    expect(renderWidgetLines(createTodoState(), theme(), 80)).toEqual([]);
  });
});

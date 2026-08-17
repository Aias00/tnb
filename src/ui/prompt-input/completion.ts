export type CompletionSource = "slash" | "custom-command" | "file" | "mcp" | "model";
export type CompletionState = {
  generation: number;
  source: CompletionSource;
  values: string[];
  selectedIndex: number;
  replacementRange: { start: number; end: number };
};

export class PromptCompletionController {
  private generation = 0;
  private state: CompletionState | undefined;

  begin(source: CompletionSource, replacementRange: { start: number; end: number }): number {
    const generation = ++this.generation;
    this.state = { generation, source, values: [], selectedIndex: 0, replacementRange };
    return generation;
  }

  resolve(generation: number, values: string[]): boolean {
    if (!this.state || generation !== this.generation) return false;
    this.state = { ...this.state, values: [...values], selectedIndex: 0 };
    return true;
  }

  move(delta: number): void {
    if (!this.state?.values.length) return;
    this.state.selectedIndex = (this.state.selectedIndex + delta + this.state.values.length) % this.state.values.length;
  }

  accept(value: string): { value: string; range: { start: number; end: number } } | undefined {
    if (!this.state) return undefined;
    const selected = this.state.values[this.state.selectedIndex];
    if (selected === undefined) return undefined;
    const range = this.state.replacementRange;
    this.cancel();
    return { value: `${value.slice(0, range.start)}${selected}${value.slice(range.end)}`, range };
  }

  cancel(): void { this.generation += 1; this.state = undefined; }
  current(): CompletionState | undefined { return this.state ? structuredClone(this.state) : undefined; }
}

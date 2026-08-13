/**
 * Fixture for the search.test.ts end-to-end suite. Deliberately small and
 * stable: an interface, an implementing class, a get/set accessor pair, a
 * free function with a few call sites, and a couple of usages that give the
 * built-in TypeScript language server unambiguous references/implementations
 * to find.
 */

export interface Greeter {
  greet(name: string): string;
}

export class EnglishGreeter implements Greeter {
  private _greeting: string = "Hello";

  get greeting(): string {
    return this._greeting;
  }

  set greeting(value: string) {
    this._greeting = value;
  }

  greet(name: string): string {
    return `${this.greeting}, ${name}!`;
  }
}

export function shout(text: string): string {
  return text.toUpperCase();
}

const greeter: Greeter = new EnglishGreeter();
console.log(shout(greeter.greet("World")));
console.log(shout(greeter.greet("VS Code")));

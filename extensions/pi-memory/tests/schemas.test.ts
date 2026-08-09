/**
 * pi-memory — Tests: schemas.
 */

import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";

import {
	DecaySchema,
	ExtractSchema,
	MemoryTypeEnum,
	SaveSchema,
	SearchSchema,
	StatusSchema
} from "../schemas.ts";

function propHasType(schema: object, prop: string, type: string): boolean {
	const s = schema as Record<string, unknown>;
	const props = s.properties as Record<string, unknown> | undefined;
	if (!props) return false;
	const p = props[prop] as Record<string, unknown> | undefined;
	return p?.type === type;
}

function propIsOptional(schema: object, prop: string): boolean {
	const s = schema as Record<string, unknown>;
	const required = s.required as string[] | undefined;
	if (!required) return true; // no required = all optional
	return !required.includes(prop);
}

function propIsRequired(schema: object, prop: string): boolean {
	const s = schema as Record<string, unknown>;
	const required = s.required as string[] | undefined;
	return required?.includes(prop) ?? false;
}

function schemaIsObject(schema: object): boolean {
	return (schema as Record<string, unknown>).type === "object";
}

function schemaHasProperty(schema: object, prop: string): boolean {
	const s = schema as Record<string, unknown>;
	const props = s.properties as Record<string, unknown> | undefined;
	return !!props && prop in props;
}
describe("memory_status schema", () => {
	it("is an object schema with no properties", () => {
		expect(schemaIsObject(StatusSchema)).toBeTrue();
		const props = (StatusSchema as unknown as Record<string, unknown>).properties as Record<string, unknown>;
		expect(Object.keys(props)).toHaveLength(0);
	});
});

describe("memory_save schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(SaveSchema)).toBeTrue();
	});

	it("has required fields: type, context, title, content, scope", () => {
		expect(propIsRequired(SaveSchema, "type")).toBeTrue();
		expect(propIsRequired(SaveSchema, "context")).toBeTrue();
		expect(propIsRequired(SaveSchema, "title")).toBeTrue();
		expect(propIsRequired(SaveSchema, "content")).toBeTrue();
		expect(propIsRequired(SaveSchema, "scope")).toBeTrue();
	});

	it("has optional fields: tags, confidence, supersedes", () => {
		expect(propIsOptional(SaveSchema, "tags")).toBeTrue();
		expect(propIsOptional(SaveSchema, "confidence")).toBeTrue();
		expect(propIsOptional(SaveSchema, "supersedes")).toBeTrue();
	});

	it("type field is a union of literal strings", () => {
		expect(schemaHasProperty(SaveSchema, "type")).toBeTrue();
		const s = SaveSchema as unknown as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const typeProp = props.type as Record<string, unknown>;
		// StringEnum cria uma união (anyOf) de literais
		const variants = (typeProp.anyOf ?? typeProp.oneOf ?? []) as Array<Record<string, unknown>>;
		expect(variants.length).toBeGreaterThan(0);
		const values = variants.map((v) => v.const);
		expect(values).toContain("_rules");
		expect(values).toContain("patterns");
	});
});

describe("memory_search schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(SearchSchema)).toBeTrue();
	});

	it("has required: query", () => {
		expect(propIsRequired(SearchSchema, "query")).toBeTrue();
	});

	it("has optional: scope, type, min_confidence, limit", () => {
		expect(propIsOptional(SearchSchema, "scope")).toBeTrue();
		expect(propIsOptional(SearchSchema, "type")).toBeTrue();
		expect(propIsOptional(SearchSchema, "min_confidence")).toBeTrue();
		expect(propIsOptional(SearchSchema, "limit")).toBeTrue();
	});

	it("query is an array of strings", () => {
		expect(propHasType(SearchSchema, "query", "array")).toBeTrue();
		const s = SearchSchema as unknown as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const q = props.query as Record<string, unknown>;
		const items = q.items as Record<string, unknown>;
		expect(items.type).toBe("string");
	});
});

describe("memory_decay schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(DecaySchema)).toBeTrue();
	});

	it("has required: context, delta", () => {
		expect(propIsRequired(DecaySchema, "context")).toBeTrue();
		expect(propIsRequired(DecaySchema, "delta")).toBeTrue();
	});

	it("has optional: move_to_supersedes, reason", () => {
		expect(propIsOptional(DecaySchema, "move_to_supersedes")).toBeTrue();
		expect(propIsOptional(DecaySchema, "reason")).toBeTrue();
	});

	it("delta is number type", () => {
		// Number no typebox pode ser "number" ou "integer" no JSON Schema
		const s = DecaySchema as unknown as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const delta = props.delta as Record<string, unknown>;
		expect(["number", "integer"]).toContain(delta.type);
	});
});

describe("memory_extract schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(ExtractSchema)).toBeTrue();
	});

	it("não tem session_file (parâmetro órfão removido)", () => {
		expect(schemaHasProperty(ExtractSchema, "session_file")).toBeFalse();
	});
});

describe("MemoryTypeEnum values", () => {
	it("is a union of literal strings", () => {
		const e = MemoryTypeEnum as unknown as Record<string, unknown>;
		expect(e.anyOf ?? e.oneOf ?? e.enum).toBeDefined();
	});

	it("contains all 5 memory types", () => {
		const e = MemoryTypeEnum as unknown as Record<string, unknown>;
		const variants = (e.anyOf ?? e.oneOf ?? []) as Array<Record<string, unknown>>;
		if (variants.length > 0) {
			// União de literais: cada um é { type: "string", const: "..." }
			const values = variants.map((v) => v.const);
			expect(values).toContain("_rules");
			expect(values).toContain("decisions");
			expect(values).toContain("gotchas");
			expect(values).toContain("lessons");
			expect(values).toContain("patterns");
		}
	});
});

describe("ScopeEnum values", () => {
	it("contains global and project", async () => {
		const { ScopeEnum } = await import("../schemas.ts");
		const s = ScopeEnum as unknown as Record<string, unknown>;
		const variants = (s.anyOf ?? s.oneOf ?? []) as Array<Record<string, unknown>>;
		const values = variants.map((v) => v.const);
		expect(values).toContain("global");
		expect(values).toContain("project");
	});
});

describe("memory_save schema summary", () => {
	it("has optional summary field", () => {
		expect(propIsOptional(SaveSchema, "summary")).toBeTrue();
	});
});


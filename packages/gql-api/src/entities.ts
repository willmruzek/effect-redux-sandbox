/** Transport-independent table definitions; response mappings flatten relationships explicitly. */
export function createEntityTable<Entity, const Name extends string>(options: {
  readonly name: Name;
  readonly key: (entity: Entity) => string;
}) {
  return {
    name: options.name,
    key: options.key,

    normalize(rows: readonly Entity[]): Readonly<Record<string, Entity>> {
      return Object.fromEntries(rows.map((entity) => {
        const key = options.key(entity);

        if (!key.trim())
          throw new Error(`Invalid entity key for ${options.name}.`);

        return [key, entity];
      }));
    },

    merge({ current, incoming }: Readonly<{
      current: Readonly<Record<string, Entity>>;
      incoming: Readonly<Record<string, Entity>>;
    }>): Readonly<Record<string, Entity>> {
      return { ...current, ...incoming };
    },
  };
}

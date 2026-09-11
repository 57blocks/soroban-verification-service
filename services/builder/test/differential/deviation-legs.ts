import type { Deviation, DifferentialFixture } from "./fixtures.js";

export type DifferentialLeg =
  | {
      id: string;
      fixtureId: string;
      kind: "reference";
      description: string;
    }
  | {
      id: string;
      fixtureId: string;
      kind: "sandbox";
      description: string;
    }
  | {
      id: string;
      fixtureId: string;
      kind: "deviation-off";
      disabledDeviation: Deviation;
      switch: TestOnlyDeviationSwitch;
      description: string;
    };

export type TestOnlyDeviationSwitch = {
  /**
   * Test-only switch for BE7 differential legs. This type deliberately lives under services/builder/test and
   * must never be imported by production src.
   */
  disable: Deviation;
};

export function buildDifferentialLegs(fixture: DifferentialFixture): DifferentialLeg[] {
  return [
    {
      id: `${fixture.id}:reference`,
      fixtureId: fixture.id,
      kind: "reference",
      description: "Pinned reference build, without the verifier sandbox deviations.",
    },
    {
      id: `${fixture.id}:sandbox`,
      fixtureId: fixture.id,
      kind: "sandbox",
      description: "Verifier rebuild with the full production sandbox profile.",
    },
    ...fixture.deviationsUnderTest.map((deviation) => ({
      id: `${fixture.id}:deviation-off:${deviation}`,
      fixtureId: fixture.id,
      kind: "deviation-off" as const,
      disabledDeviation: deviation,
      switch: testOnlyDeviationSwitch(deviation),
      description: `Verifier rebuild with only ${deviation} disabled for BE7 byte-neutrality measurement.`,
    })),
  ];
}

export function testOnlyDeviationSwitch(deviation: Deviation): TestOnlyDeviationSwitch {
  return { disable: deviation };
}

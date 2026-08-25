import * as assert from "assert";
import { isTestProjectContent } from "../testProject";

/**
 * Pure unit suite for {@link isTestProjectContent} — the `.csproj` XML
 * predicate, no VS Code APIs involved. The directory-walk/caching half
 * ({@link TestProjectClassifier}) is thin I/O over this function and is
 * exercised end-to-end by the search e2e suite.
 */
suite("isTestProjectContent", () => {
  const NON_TEST = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`;

  test("a plain library project is not a test project", () => {
    assert.strictEqual(isTestProjectContent(NON_TEST), false);
  });

  test("<IsTestProject>true</IsTestProject> marks a test project", () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup>
</Project>`;
    assert.strictEqual(isTestProjectContent(xml), true);
  });

  test("<IsTestProject>false</IsTestProject> opts out even with a test package present", () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
  </ItemGroup>
</Project>`;
    assert.strictEqual(isTestProjectContent(xml), false);
  });

  test("Microsoft.NET.Test.Sdk package reference marks a test project", () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
  </ItemGroup>
</Project>`;
    assert.strictEqual(isTestProjectContent(xml), true);
  });

  test("MSTest.Sdk project SDK attribute marks a test project", () => {
    const xml = `<Project Sdk="MSTest.Sdk/3.6.4">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
</Project>`;
    assert.strictEqual(isTestProjectContent(xml), true);
  });

  suite("test-framework package families", () => {
    const packages = [
      "xunit",
      "xunit.runner.visualstudio",
      "NUnit",
      "NUnit3TestAdapter",
      "MSTest.TestFramework",
      "MSTest.TestAdapter",
    ];
    for (const pkg of packages) {
      test(`${pkg} marks a test project`, () => {
        const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="${pkg}" Version="1.0.0" />
  </ItemGroup>
</Project>`;
        assert.strictEqual(isTestProjectContent(xml), true);
      });
    }
  });

  test("a similarly-named non-test package does not match (e.g. Xunitish false-friend guard)", () => {
    // Not a real package; guards against an over-broad substring match. Our
    // rule is prefix-based, so an unrelated package that merely *contains*
    // "test" must not trigger.
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="AutoFixture.Contrib" Version="1.0.0" />
    <PackageReference Include="FluentAssertions" Version="6.12.0" />
  </ItemGroup>
</Project>`;
    assert.strictEqual(isTestProjectContent(xml), false);
  });

  test("empty or malformed content is not a test project", () => {
    assert.strictEqual(isTestProjectContent(""), false);
    assert.strictEqual(isTestProjectContent("not xml at all"), false);
  });
});

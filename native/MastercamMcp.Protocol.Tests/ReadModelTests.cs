using System;
using System.Linq;
using MastercamMcp.ReadModel;
using MastercamMcp.Addin.V2027;
using System.Text.Json;
using System.Threading;
using Xunit;

namespace Mastercam.Support
{
    public static class SearchManager
    {
        public static object[] Operations { get; set; } = Array.Empty<object>();
        public static object[] GetOperations() => Operations;
    }
}

namespace MastercamMcp.Protocol.Tests
{
    public sealed class FakeTool
    {
        public int ToolNumber { get; set; }
        public string ToolName { get; set; }
        public double Diameter { get; set; }
        public string InsertGrade { get; set; }
    }

    public sealed class FakeQuantity
    {
        public double Value { get; set; }
        public string Unit { get; set; }
    }

    public sealed class FakeOperation
    {
        public int OperationId { get; set; }
        public string OperationName { get; set; }
        public string OperationType { get; set; }
        public FakeQuantity FeedRate { get; set; }
        public int SpindleRpm { get; set; }
        public bool NeedsRegeneration { get; set; }
        public FakeTool Tool { get; set; }
        public string Dangerous => throw new InvalidOperationException("must not escape");
    }

    public class ReadModelTests
    {
        [Fact]
        public void ProbeFindsPublicSearchManagerContract()
        {
            var probe = SafeReflection.ProbeLoadedAssemblies(AppDomain.CurrentDomain.GetAssemblies());
            Assert.True(probe.SearchManagerFound);
            Assert.True(probe.GetOperationsFound);
            Assert.True(probe.CanReadProgrammingContext);
        }

        [Fact]
        public void MapsOperationAndReferencedToolWithoutWalkingArbitraryGraph()
        {
            var operation = new FakeOperation
            {
                OperationId = 42,
                OperationName = "OD Rough",
                OperationType = "Turning Rough",
                FeedRate = new FakeQuantity { Value = 0.25, Unit = "mm/rev" },
                SpindleRpm = 1800,
                NeedsRegeneration = true,
                Tool = new FakeTool
                {
                    ToolNumber = 7,
                    ToolName = "CNMG Rougher",
                    Diameter = 12.7,
                    InsertGrade = "P25"
                }
            };

            var mapped = SafeReflection.MapOperation(operation);
            Assert.Equal(42, mapped.Id);
            Assert.Equal("OD Rough", mapped.Name);
            Assert.Equal("Turning Rough", mapped.Type);
            Assert.Equal(1800, Convert.ToInt32(mapped.SpindleSpeed));
            Assert.True(mapped.ToolpathDirty);
            Assert.Equal(7, mapped.Tool);
            Assert.NotNull(mapped.ToolRecord);
            Assert.Equal("CNMG Rougher", mapped.ToolRecord.Name);
            Assert.Equal("P25", mapped.ToolRecord.Grade);

            var quantity = Assert.IsType<System.Collections.Generic.Dictionary<string, object>>(mapped.FeedRate);
            Assert.Equal(0.25, Assert.IsType<double>(quantity["value"]), 6);
            Assert.Equal("mm/rev", quantity["unit"]);
        }

        [Fact]
        public void SnapshotRevisionIsDeterministicAndStableIdsAreRequired()
        {
            var operation = new FakeOperation
            {
                OperationId = 1,
                OperationName = "Finish",
                OperationType = "Turning Finish",
                FeedRate = new FakeQuantity { Value = 0.1, Unit = "mm/rev" },
                SpindleRpm = 2200,
                Tool = new FakeTool { ToolNumber = 2, ToolName = "VNMG" }
            };

            var first = SafeReflection.BuildProgrammingSnapshot(new object[] { operation }, "test");
            var second = SafeReflection.BuildProgrammingSnapshot(new object[] { operation }, "test");

            Assert.True(first.Coverage.OperationsEnumerated);
            Assert.True(first.Coverage.StableOperationIds);
            Assert.True(first.Coverage.ReferencedToolsEnumerated);
            Assert.Equal(first.DocumentRevision, second.DocumentRevision);
            Assert.Single(first.Tools);
        }

        [Fact]
        public void MissingStableIdIsReportedInsteadOfInventingOne()
        {
            var anonymous = new { Name = "Unnamed Op", ToolNumber = 3 };
            var snapshot = SafeReflection.BuildProgrammingSnapshot(new object[] { anonymous }, "test");

            Assert.False(snapshot.Coverage.StableOperationIds);
            Assert.Null(snapshot.Operations.Single().Id);
            Assert.Contains(snapshot.Coverage.Unknowns, item => item.Contains("stable numeric operation identifier"));
        }

        [Fact]
        public void EnumerationIsBounded()
        {
            var operations = Enumerable.Range(1, 20)
                .Select(id => (object)new FakeOperation
                {
                    OperationId = id,
                    OperationName = "Op " + id,
                    OperationType = "Test",
                    Tool = new FakeTool { ToolNumber = id }
                });
            var snapshot = SafeReflection.BuildProgrammingSnapshot(operations, "test", maxOperations: 5);

            Assert.Equal(5, snapshot.Operations.Count);
            Assert.Contains(snapshot.Coverage.Unknowns, item => item.Contains("truncated"));
        }

        [Fact]
        public void StageBAdapterIsOptInAndReportsImplementedNotVerified()
        {
            var previous = Environment.GetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS");
            try
            {
                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", null);
                var disabled = new EnvironmentAdapter().Capabilities()
                    .Single(item => item.Name == "get_programming_context");
                Assert.False(disabled.Supported);

                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", "1");
                var enabled = new EnvironmentAdapter().Capabilities()
                    .Single(item => item.Name == "get_programming_context");
                Assert.True(enabled.Supported);
                Assert.Equal(MastercamMcp.Adapter.Abstractions.CapabilityTier.Implemented, enabled.Tier);
            }
            finally
            {
                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", previous);
            }
        }

        [Fact]
        public void StageBReaderBuildsContextAndDerivedReadsFromOneContract()
        {
            var previous = Environment.GetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS");
            try
            {
                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", "1");
                Mastercam.Support.SearchManager.Operations = new object[]
                {
                    new FakeOperation
                    {
                        OperationId = 101,
                        OperationName = "OD Rough",
                        OperationType = "Turning Rough",
                        FeedRate = new FakeQuantity { Value = 0.3, Unit = "mm/rev" },
                        SpindleRpm = 1600,
                        NeedsRegeneration = true,
                        Tool = new FakeTool { ToolNumber = 7, ToolName = "CNMG", Diameter = 12.7 }
                    },
                    new FakeOperation
                    {
                        OperationId = 102,
                        OperationName = "OD Finish",
                        OperationType = "Turning Finish",
                        FeedRate = new FakeQuantity { Value = 0.12, Unit = "mm/rev" },
                        SpindleRpm = 2200,
                        NeedsRegeneration = false,
                        Tool = new FakeTool { ToolNumber = 8, ToolName = "VNMG", Diameter = 9.525 }
                    }
                };
                ProgrammingContextReader.InvalidateCache();

                var context = ProgrammingContextTools.Invoke(
                    "get_programming_context",
                    "{}",
                    CancellationToken.None);
                Assert.True(context.Ok);
                var snapshot = Assert.IsType<ProgrammingSnapshot>(context.Data);
                Assert.Equal(2, snapshot.Operations.Count);
                Assert.True(snapshot.Coverage.StableOperationIds);

                var operations = ProgrammingContextTools.Invoke(
                    "list_operations",
                    "{\"limit\":10,\"offset\":0}",
                    CancellationToken.None);
                Assert.True(operations.Ok);
                using var operationsJson = JsonDocument.Parse(JsonSerializer.Serialize(operations.Data));
                Assert.Equal(2, operationsJson.RootElement.GetArrayLength());
                Assert.Equal(101, operationsJson.RootElement[0].GetProperty("id").GetInt32());

                var tools = ProgrammingContextTools.Invoke(
                    "list_tools",
                    "{\"limit\":10}",
                    CancellationToken.None);
                Assert.True(tools.Ok);
                using var toolsJson = JsonDocument.Parse(JsonSerializer.Serialize(tools.Data));
                Assert.Equal(2, toolsJson.RootElement.GetArrayLength());
                Assert.False(toolsJson.RootElement[0]
                    .GetProperty("provenance")
                    .GetProperty("completeLibraryRecord")
                    .GetBoolean());

                var dirty = ProgrammingContextTools.Invoke(
                    "get_dirty_toolpaths",
                    "{}",
                    CancellationToken.None);
                Assert.True(dirty.Ok);
                using var dirtyJson = JsonDocument.Parse(JsonSerializer.Serialize(dirty.Data));
                Assert.Equal(101, dirtyJson.RootElement.GetProperty("operationIds")[0].GetInt32());
            }
            finally
            {
                ProgrammingContextReader.InvalidateCache();
                Mastercam.Support.SearchManager.Operations = Array.Empty<object>();
                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", previous);
            }
        }

        [Fact]
        public void IdentityDependentStageBReadsFailClosedWithoutStableIds()
        {
            var previous = Environment.GetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS");
            try
            {
                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", "1");
                Mastercam.Support.SearchManager.Operations = new object[]
                {
                    new { Name = "No stable id", ToolNumber = 2 }
                };
                ProgrammingContextReader.InvalidateCache();

                var result = ProgrammingContextTools.Invoke(
                    "get_operation",
                    "{\"operationId\":1}",
                    CancellationToken.None);

                Assert.False(result.Ok);
                Assert.Equal("MAPPING_INCOMPLETE", result.ErrorCode);
            }
            finally
            {
                ProgrammingContextReader.InvalidateCache();
                Mastercam.Support.SearchManager.Operations = Array.Empty<object>();
                Environment.SetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS", previous);
            }
        }
    }
}

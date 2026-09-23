using System;
using System.Linq;
using MastercamMcp.ReadModel;
using Xunit;

namespace Mastercam.Support
{
    public static class SearchManager
    {
        public static object[] GetOperations() => Array.Empty<object>();
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
    }
}

package io.visualzpl.batch;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static io.visualzpl.batch.BatchZpl.ConsumerType;
import static io.visualzpl.batch.BatchZpl.IssueCode;
import static io.visualzpl.batch.BatchZpl.Severity;
import static io.visualzpl.batch.BatchZpl.ValidationResult;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit tests for the server-side BatchZpl module — covers placeholder
 * extraction, per-row substitution, and the strictest-rule-wins validation
 * pipeline. Mirrors the contract enforced by the frontend implementation so
 * both sides cannot drift apart silently.
 */
class BatchZplTest {

    // ──────────────────────────────────────────────────────────────────
    @Nested
    class ExtractVariables {

        @Test
        void returnsVariablesInDiscoveryOrder() {
            List<String> vars = BatchZpl.extractVariables(
                    "Hello {{Name}}, your tracking is {{TrackingNumber}} (re-hi {{Name}})"
            );
            assertEquals(
                    List.of("Name", "TrackingNumber"),
                    vars,
                    "Distinct names should be returned in first-seen order"
            );
        }

        @Test
        void returnsEmptyForPlainText() {
            assertTrue(
                    BatchZpl.extractVariables("no placeholders here").isEmpty(),
                    "Plain text should yield zero variables"
            );
        }

        @Test
        void ignoresMalformedPlaceholders() {
            // Single braces and digit-prefixed names are not valid identifiers.
            List<String> vars = BatchZpl.extractVariables(
                    "{NotAVar} {{1NotValid}} {{Good_Name}}"
            );
            assertEquals(List.of("Good_Name"), vars);
        }
    }

    // ──────────────────────────────────────────────────────────────────
    @Nested
    class GenerateBatchZpl {

        @Test
        void substitutesVariablesPerRow() {
            String template = "^XA^FD{{Name}}={{Value}}^FS^XZ";
            List<Map<String, String>> rows = List.of(
                    Map.of("Name", "Alpha", "Value", "1"),
                    Map.of("Name", "Beta",  "Value", "2")
            );

            String out = BatchZpl.generateBatchZpl(template, rows);

            assertTrue(out.contains("^FDAlpha=1^FS"), "Row 0 should be substituted");
            assertTrue(out.contains("^FDBeta=2^FS"),  "Row 1 should be substituted");
            assertEquals(
                    2,
                    out.split("\\^XA", -1).length - 1,
                    "Output should contain exactly two ^XA blocks"
            );
        }

        @Test
        void treatsMissingValueAsEmptyString() {
            String template = "^XA^FD{{A}}|{{B}}^FS^XZ";
            List<Map<String, String>> rows = List.of(Map.of("A", "x"));

            String out = BatchZpl.generateBatchZpl(template, rows);

            assertTrue(
                    out.contains("^FDx|^FS"),
                    "Missing variable B should render as an empty string between the pipes"
            );
        }

        @Test
        void escapesControlCharactersInsideSubstitutedValues() {
            String template = "^XA^FD{{X}}^FS^XZ";
            List<Map<String, String>> rows = List.of(Map.of("X", "evil^XA~stuff"));

            String out = BatchZpl.generateBatchZpl(template, rows);

            assertFalse(
                    out.contains("^XA~"),
                    "ZPL control characters in substituted values must be sanitized"
            );
            assertTrue(
                    out.contains("^FDevil XA stuff^FS"),
                    "^ and ~ should be replaced by spaces in the substituted region"
            );
        }

        @Test
        void returnsBaseZplUnchangedWhenRowsEmpty() {
            String template = "^XA^FDStatic^FS^XZ";
            assertEquals(template, BatchZpl.generateBatchZpl(template, List.of()));
        }

        @Test
        void preservesNonVariableContentInBetweenLabels() {
            String template = "^XA^FD{{N}}^FS^XZ";
            List<Map<String, String>> rows = List.of(
                    Map.of("N", "a"),
                    Map.of("N", "b")
            );

            String out = BatchZpl.generateBatchZpl(template, rows);

            // The join must be a single newline between consecutive labels.
            assertEquals(
                    "^XA^FDa^FS^XZ\n^XA^FDb^FS^XZ",
                    out
            );
        }
    }

    // ──────────────────────────────────────────────────────────────────
    @Nested
    class ValidateBatchData {

        @Test
        void barcodeEmptyValueIsErrorEmptyRequiredField() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(Map.of("Code", ""))
            );

            assertEquals(1, result.errorCount());
            assertEquals(0, result.warningCount());
            assertEquals(IssueCode.EMPTY_REQUIRED_FIELD, result.issues().get(0).code());
            assertEquals(Severity.ERROR, result.issues().get(0).severity());
        }

        @Test
        void barcodeNonAsciiValueIsErrorNonAscii() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(Map.of("Code", "한글"))
            );

            assertEquals(1, result.errorCount());
            assertEquals(IssueCode.NON_ASCII_CHARACTER, result.issues().get(0).code());
        }

        @Test
        void barcodeWithCaretIsErrorBarcodeRule() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(Map.of("Code", "ABC^XYZ"))
            );

            assertEquals(1, result.errorCount());
            assertEquals(IssueCode.BARCODE_RULE_EXCEPTION, result.issues().get(0).code());
        }

        @Test
        void barcodeWithTildeIsErrorBarcodeRule() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(Map.of("Code", "ABC~DEF"))
            );

            assertEquals(1, result.errorCount());
            assertEquals(IssueCode.BARCODE_RULE_EXCEPTION, result.issues().get(0).code());
        }

        @Test
        void barcodePrintableAsciiPasses() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(Map.of("Code", "ABC-123_XYZ"))
            );

            assertEquals(0, result.errorCount());
            assertEquals(0, result.warningCount());
        }

        @Test
        void qrCodeAcceptsNonAscii() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Url", Set.of(ConsumerType.QRCODE)),
                    List.of(Map.of("Url", "https://example.com/한글"))
            );

            assertEquals(0, result.errorCount());
            assertEquals(0, result.warningCount());
        }

        @Test
        void qrCodeEmptyValueIsWarning() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Url", Set.of(ConsumerType.QRCODE)),
                    List.of(Map.of("Url", ""))
            );

            assertEquals(0, result.errorCount());
            assertEquals(1, result.warningCount());
            assertEquals(IssueCode.EMPTY_REQUIRED_FIELD, result.issues().get(0).code());
        }

        @Test
        void textWithControlCharIsWarning() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Field", Set.of(ConsumerType.TEXT)),
                    List.of(Map.of("Field", "Hello ^X"))
            );

            assertEquals(0, result.errorCount());
            assertEquals(1, result.warningCount());
            assertEquals(IssueCode.CONTROL_CHARACTER_WARNING, result.issues().get(0).code());
        }

        @Test
        void textWithRegularAsciiHasNoIssues() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Field", Set.of(ConsumerType.TEXT)),
                    List.of(Map.of("Field", "Plain ASCII content"))
            );

            assertEquals(0, result.errorCount());
            assertEquals(0, result.warningCount());
        }

        @Test
        void strictestRuleWinsWhenVariableSharedAcrossTextAndBarcode() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Shared", Set.of(ConsumerType.TEXT, ConsumerType.BARCODE)),
                    List.of(Map.of("Shared", "한"))
            );

            // The TEXT rule alone would warn; the BARCODE rule escalates to ERROR.
            assertEquals(1, result.errorCount(),
                    "Barcode constraint should override text-level warning");
            assertEquals(0, result.warningCount());
            assertEquals(IssueCode.NON_ASCII_CHARACTER, result.issues().get(0).code());
        }

        @Test
        void multiRowResultsAreAggregatedPerCell() {
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(
                            Map.of("Code", "GOOD-001"), // row 0 — valid
                            Map.of("Code", "한"),        // row 1 — non-ascii
                            Map.of("Code", "BAD^XA")    // row 2 — control char
                    )
            );

            assertEquals(2, result.errorCount());
            assertNull(result.byCell().get(BatchZpl.cellKey(0, "Code")),
                    "Row 0 must not appear in byCell");
            assertNotNull(result.byCell().get(BatchZpl.cellKey(1, "Code")),
                    "Row 1 cell must carry the non-ascii issue");
            assertNotNull(result.byCell().get(BatchZpl.cellKey(2, "Code")),
                    "Row 2 cell must carry the control-character issue");
        }

        @Test
        void missingValueForBarcodeIsErrorRatherThanSilentEmpty() {
            // The row literally omits the key — `row.getOrDefault(name, "")`
            // makes the cell behave as if it were an empty string, which is
            // an error for barcodes.
            ValidationResult result = BatchZpl.validateBatchData(
                    Map.of("Code", Set.of(ConsumerType.BARCODE)),
                    List.of(Map.of()) // no "Code" key at all
            );

            assertEquals(1, result.errorCount());
            assertEquals(IssueCode.EMPTY_REQUIRED_FIELD, result.issues().get(0).code());
        }
    }
}

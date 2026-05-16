package io.visualzpl.batch;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Server-side mirror of the frontend BatchZpl module.
 *
 * Provides three pure-function entry points so the backend can:
 *   - Extract `{{Variable}}` placeholders from any ZPL template.
 *   - Generate a concatenated batch ZPL stream by performing per-row
 *     substitution against a precompiled base ZPL.
 *   - Validate a grid of input rows against the strictest rule implied by
 *     the consuming object type (Text / Barcode / QR Code).
 *
 * The implementation deliberately stays self-contained — no Spring beans,
 * no IO, no logging — so the unit tests in BatchZplTest can exercise every
 * branch in isolation.
 */
public final class BatchZpl {

    private BatchZpl() {
        // utility class
    }

    /** Matches `{{VariableName}}` tokens. Names must start with a letter or `_`. */
    public static final Pattern VARIABLE_PATTERN =
            Pattern.compile("\\{\\{([A-Za-z_][A-Za-z0-9_]*)}}");

    /** Discriminates the label-object type that consumes a variable. */
    public enum ConsumerType {
        TEXT, BARCODE, QRCODE
    }

    /** Severity of a single validation issue. */
    public enum Severity {
        WARNING, ERROR
    }

    /** Stable machine-readable codes shared with the frontend implementation. */
    public enum IssueCode {
        BARCODE_RULE_EXCEPTION,
        EMPTY_REQUIRED_FIELD,
        CONTROL_CHARACTER_WARNING,
        NON_ASCII_CHARACTER
    }

    public record ValidationIssue(
            int rowIndex,
            String variableName,
            Severity severity,
            IssueCode code,
            String message
    ) {}

    public record ValidationResult(
            List<ValidationIssue> issues,
            Map<String, ValidationIssue> byCell,
            int errorCount,
            int warningCount
    ) {}

    private static final int PRINTABLE_ASCII_MIN = 0x20; // space
    private static final int PRINTABLE_ASCII_MAX = 0x7E; // tilde

    /** Stable map key used in {@link ValidationResult#byCell()}. */
    public static String cellKey(int rowIndex, String variableName) {
        return rowIndex + "#" + variableName;
    }

    /**
     * Returns every distinct `{{name}}` placeholder found in `text`, in the
     * order it was first encountered. Useful when the caller needs to render
     * a column header per variable (matches the frontend behavior).
     */
    public static List<String> extractVariables(String text) {
        Set<String> seen = new LinkedHashSet<>();
        Matcher matcher = VARIABLE_PATTERN.matcher(text);
        while (matcher.find()) {
            seen.add(matcher.group(1));
        }
        return List.copyOf(seen);
    }

    /**
     * Mirrors ZplBuilder.escapeFieldData — `^` and `~` are ZPL control
     * prefixes, so any substituted user value containing them is sanitized
     * to a space before reaching the printer.
     */
    private static String escapeForZpl(String value) {
        return value.replaceAll("[\\^~]", " ");
    }

    /**
     * Performs per-row variable substitution on a precompiled base ZPL
     * string. Missing values for a `{{name}}` placeholder are replaced
     * with an empty string. The output joins `^XA…^XZ` blocks with newlines
     * so the firmware advances and cuts one label per block.
     */
    public static String generateBatchZpl(String baseZpl, List<Map<String, String>> rows) {
        if (rows.isEmpty()) {
            return baseZpl;
        }
        StringBuilder out = new StringBuilder(baseZpl.length() * rows.size());
        for (int i = 0; i < rows.size(); i++) {
            Map<String, String> row = rows.get(i);
            Matcher matcher = VARIABLE_PATTERN.matcher(baseZpl);
            StringBuilder rendered = new StringBuilder(baseZpl.length());
            while (matcher.find()) {
                String name = matcher.group(1);
                String value = row.get(name);
                String replacement = value != null ? escapeForZpl(value) : "";
                matcher.appendReplacement(rendered, Matcher.quoteReplacement(replacement));
            }
            matcher.appendTail(rendered);
            if (i > 0) {
                out.append('\n');
            }
            out.append(rendered);
        }
        return out.toString();
    }

    /**
     * Validates every cell of `rows` against the strictest rule implied by
     * the consuming object type:
     *   BARCODE > QRCODE > TEXT  (strictest first)
     *
     * The `consumers` map must list which ConsumerType set each variable
     * appears in. A variable shared between TEXT and BARCODE is held to
     * the BARCODE rule (NON_ASCII_CHARACTER becomes an ERROR rather than
     * the TEXT-level CONTROL_CHARACTER_WARNING).
     */
    public static ValidationResult validateBatchData(
            Map<String, Set<ConsumerType>> consumers,
            List<Map<String, String>> rows
    ) {
        List<ValidationIssue> issues = new ArrayList<>();
        for (int rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
            Map<String, String> row = rows.get(rowIndex);
            for (Map.Entry<String, Set<ConsumerType>> entry : consumers.entrySet()) {
                String name = entry.getKey();
                String value = row.getOrDefault(name, "");
                ValidationIssue issue = validateCellValue(rowIndex, name, value, entry.getValue());
                if (issue != null) {
                    issues.add(issue);
                }
            }
        }

        Map<String, ValidationIssue> byCell = new HashMap<>();
        for (ValidationIssue issue : issues) {
            String key = cellKey(issue.rowIndex(), issue.variableName());
            ValidationIssue existing = byCell.get(key);
            if (existing == null
                    || severityRank(issue.severity()) > severityRank(existing.severity())) {
                byCell.put(key, issue);
            }
        }

        int errorCount = 0;
        int warningCount = 0;
        for (ValidationIssue issue : byCell.values()) {
            if (issue.severity() == Severity.ERROR) {
                errorCount++;
            } else {
                warningCount++;
            }
        }

        return new ValidationResult(
                Collections.unmodifiableList(issues),
                Collections.unmodifiableMap(byCell),
                errorCount,
                warningCount
        );
    }

    private static int severityRank(Severity severity) {
        return severity == Severity.ERROR ? 2 : 1;
    }

    private static ValidationIssue validateCellValue(
            int rowIndex,
            String variableName,
            String value,
            Set<ConsumerType> consumers
    ) {
        if (consumers.contains(ConsumerType.BARCODE)) {
            if (value.isEmpty()) {
                return new ValidationIssue(
                        rowIndex, variableName, Severity.ERROR,
                        IssueCode.EMPTY_REQUIRED_FIELD,
                        "Barcode value cannot be empty.");
            }
            for (int i = 0; i < value.length(); i++) {
                char ch = value.charAt(i);
                int code = ch;
                if (ch == '^' || ch == '~') {
                    return new ValidationIssue(
                            rowIndex, variableName, Severity.ERROR,
                            IssueCode.BARCODE_RULE_EXCEPTION,
                            "ZPL control characters ^ and ~ are not allowed in barcode data.");
                }
                if (code < PRINTABLE_ASCII_MIN || code > PRINTABLE_ASCII_MAX) {
                    return new ValidationIssue(
                            rowIndex, variableName, Severity.ERROR,
                            IssueCode.NON_ASCII_CHARACTER,
                            String.format(
                                    "Code 128 does not support character \"%c\" (U+%04X).",
                                    ch, code));
                }
            }
            return null;
        }

        if (consumers.contains(ConsumerType.QRCODE)) {
            if (value.isEmpty()) {
                return new ValidationIssue(
                        rowIndex, variableName, Severity.WARNING,
                        IssueCode.EMPTY_REQUIRED_FIELD,
                        "QR code value is empty.");
            }
            if (containsControlChar(value)) {
                return new ValidationIssue(
                        rowIndex, variableName, Severity.WARNING,
                        IssueCode.CONTROL_CHARACTER_WARNING,
                        "Control characters ^ and ~ will be replaced with spaces on print.");
            }
            return null;
        }

        // Text — least restrictive: only warn on ZPL control characters.
        if (containsControlChar(value)) {
            return new ValidationIssue(
                    rowIndex, variableName, Severity.WARNING,
                    IssueCode.CONTROL_CHARACTER_WARNING,
                    "Control characters ^ and ~ will be replaced with spaces on print.");
        }
        return null;
    }

    private static boolean containsControlChar(String value) {
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '^' || ch == '~') {
                return true;
            }
        }
        return false;
    }
}

package io.visualzpl.batch;

/**
 * Thrown when a substituted value violates Code 128 character constraints.
 *
 * The frontend mirrors this exception with a `BarcodeRuleException` class
 * in BatchZpl.ts so both layers share a single semantic vocabulary for
 * client-visible barcode failures.
 */
public class BarcodeRuleException extends RuntimeException {

    public BarcodeRuleException(String message) {
        super(message);
    }
}

-- The hardware a host emulates, as its owner enters it, e.g. "VAX-11/780"
-- for a SimH on a Raspberry Pi.
ALTER TABLE host ADD COLUMN emulated_hardware VARCHAR;

// Headless Ghidra post-script: dump decompiled C for every function plus exports/imports/strings.
// Output dir is passed as the first script argument.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.data.StringDataInstance;
import java.io.*;
import java.util.*;

public class DumpAll extends GhidraScript {
    @Override
    public void run() throws Exception {
        String outDir = getScriptArgs().length > 0 ? getScriptArgs()[0] : "/tmp";
        String name = currentProgram.getName();
        new File(outDir).mkdirs();

        try (PrintWriter w = new PrintWriter(new FileWriter(new File(outDir, name + ".symbols.txt")))) {
            w.println("## EXPORTS");
            SymbolTable st = currentProgram.getSymbolTable();
            for (Symbol s : st.getAllSymbols(true)) {
                if (s.isExternalEntryPoint()) w.println(s.getAddress() + "  " + s.getName(true));
            }
            w.println("\n## IMPORTS");
            for (Symbol s : st.getExternalSymbols()) {
                w.println(s.getParentNamespace().getName() + "!" + s.getName());
            }
            w.println("\n## STRINGS");
            for (Data d : currentProgram.getListing().getDefinedData(true)) {
                if (!StringDataInstance.isString(d)) continue;
                StringDataInstance sdi = StringDataInstance.getStringDataInstance(d);
                String v = sdi.getStringValue();
                if (v != null && v.length() >= 4) w.println(d.getAddress() + "  " + v.replace("\n", "\n").replace("\r", "\r"));
            }
        }

        DecompInterface di = new DecompInterface();
        DecompileOptions opts = new DecompileOptions();
        di.setOptions(opts);
        di.openProgram(currentProgram);
        int n = 0, fail = 0;
        try (PrintWriter w = new PrintWriter(new FileWriter(new File(outDir, name + ".c")))) {
            w.println("// Ghidra decompilation of " + name);
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                if (monitor.isCancelled()) break;
                if (f.isThunk() || f.isExternal()) continue;
                DecompileResults r = di.decompileFunction(f, 120, monitor);
                w.println("\n// ===== " + f.getName() + " @ " + f.getEntryPoint() + (f.getSymbol().isExternalEntryPoint() ? "  [EXPORT]" : ""));
                if (r != null && r.decompileCompleted()) { w.println(r.getDecompiledFunction().getC()); n++; }
                else { w.println("// decompile failed: " + (r == null ? "null" : r.getErrorMessage())); fail++; }
            }
        }
        di.dispose();
        println("DumpAll: " + name + " functions=" + n + " failed=" + fail);
    }
}

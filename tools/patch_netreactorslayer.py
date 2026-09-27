#!/usr/bin/env python3
"""Patch NETReactorSlayer so dynamic string decryption works on .NET 8/Linux.

The stock tool uses Harmony (MonoMod) to spoof StackFrame.GetMethod() for the decrypter's
caller check, which segfaults on .NET 8. The .NET Reactor decrypter only performs that check
while a static counter is < 75, so we set that counter via reflection instead.
"""
import sys, re, pathlib
p = pathlib.Path(sys.argv[1]) / "NETReactorSlayer.Core/Stages/StringDecrypter.cs"
s = p.read_text()
if "BypassCallerCheck" in s:
    print("already patched"); sys.exit(0)
s = s.replace("            StacktracePatcher.Patch();\n", "")
s = s.replace("                        var result = (StacktracePatcher.PatchStackTraceGetMethod.MethodToReplace =",
              "                        BypassCallerCheck(methodDef);\n                        var result = (StacktracePatcher.PatchStackTraceGetMethod.MethodToReplace =")
helper = '''
        private readonly HashSet<uint> _bypassed = new();

        private void BypassCallerCheck(MethodDef methodDef)
        {
            if (!_bypassed.Add(methodDef.MDToken.Raw))
                return;
            var ins = methodDef.Body.Instructions;
            for (var k = 0; k + 1 < ins.Count; k++)
            {
                if (ins[k].OpCode.Code != Code.Ldsfld || !ins[k + 1].IsLdcI4() || ins[k + 1].GetLdcI4Value() != 75)
                    continue;
                if (ins[k].Operand is not IField f)
                    continue;
                var fi = Context.Assembly.ManifestModule.ResolveField((int)f.MDToken.Raw);
                if (fi != null && fi.FieldType == typeof(int))
                    fi.SetValue(null, 1 << 30);
            }
        }

        private IContext Context { get; set; }'''
s = s.replace("\n        private IContext Context { get; set; }", helper, 1)
if "using dnlib.DotNet.Emit;" not in s:
    s = "using dnlib.DotNet.Emit;\n" + s
p.write_text(s)
print("patched", p)

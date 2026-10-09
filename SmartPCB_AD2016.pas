{ SmartPCB 3.0 - native adapter for Altium Designer 16.1.
  Entry points: SmartAuto, SmartRouteOnly, PreviewSmart.
  Uses an independent local placement/router engine; never invokes Situs.
  All geometry uses absolute Altium coordinates, converted to millimetres.
  Native API names were checked against the installed AD16 scripting DLL and
  the official legacy API reference. THIS ADAPTER HAS NOT BEEN RUN IN AD16.
  Solver is geometrically validated; Altium DRC and electrical review remain
  required. Unsupported copper geometry/nets are explicitly protected.
}

Const
    SP_VERSION = '3.0';
    SP_MAX_COMPONENTS = 2048;
    SP_MAX_NETS = 8192;
    SP_MAX_LAYERS = 8;
    SP_MAX_COORD = 999990000;
    SP_MAX_PLAN_OBJECTS = 200000;
    SP_TIMEOUT_SECONDS = 1800;
    SP_DEFAULT_NODE = 'D:\nodejs\node.exe';
    SP_FALLBACK_FOLDER = 'D:\down\SmartPCB_AD2016_v3\SmartPCB_AD2016';

Var
    SP_Board : IPCB_Board;
    SP_Doc : IServerDocument;
    SP_Comp : Array[0..2047] Of IPCB_Component;
    SP_NewObjects : Array[0..199999] Of IPCB_Primitive;
    SP_Net : Array[0..8191] Of IPCB_Net;
    SP_NetNames, SP_Protected, SP_Obstacles, SP_RawRules : TStringList;
    SP_Manual : Array[0..8191] Of String;
    SP_CompLocked : Array[0..2047] Of Boolean;
    SP_Layer : Array[0..7] Of TLayer;
    SP_LayerName : Array[0..7] Of String;
    SP_Allowed : Array[0..65535] Of Boolean;
    SP_Width, SP_MinWidth, SP_MaxWidth : Array[0..65535] Of Double;
    SP_ViaDiameter, SP_ViaHole, SP_Priority : Array[0..8191] Of Double;
    SP_CCount, SP_NCount, SP_LCount : Integer;
    SP_Clearance : Double;
    SP_HasPlanes, SP_SpatialWidth, SP_Busy : Boolean;
    SP_Mode, SP_EngineDir, SP_RunDir, SP_CopyPath, SP_OriginalPath, SP_NodePath : String;
    SP_MoveCount, SP_TrackCount, SP_ViaCount : Integer;

Procedure SP_Fail(MessageText : String);
Begin
    Raise(MessageText);
End;

Function SP_Number(Value : Double) : String;
Var S : String; I : Integer;
Begin
    S := FormatFloat('0.00000000', Value);
    For I := 1 To Length(S) Do If S[I] = ',' Then S[I] := '.';
    Result := S;
End;

Function SP_MM(Value : TCoord) : String;
Begin
    Result := SP_Number(CoordToMMs(Value));
End;

Function SP_Bool(Value : Boolean) : String;
Begin
    If Value Then Result := 'true' Else Result := 'false';
End;

Function SP_JSON(Value : String) : String;
Var I, N : Integer; C : String;
Begin
    Result := '"';
    For I := 1 To Length(Value) Do
    Begin
        C := Value[I]; N := Ord(Value[I]);
        If C = '"' Then Result := Result + '\"'
        Else If C = '\' Then Result := Result + '\\'
        Else If (N < 32) Or (N > 126) Then Result := Result + '\u' + IntToHex(N, 4)
        Else Result := Result + C;
    End;
    Result := Result + '"';
End;

Function SP_PSQuote(Value : String) : String;
Var I : Integer;
Begin
    Result := '''';
    For I := 1 To Length(Value) Do
    Begin
        If (Value[I] = #10) Or (Value[I] = #13) Or (Value[I] = '"') Then SP_Fail('Invalid character in an executable/file path.');
        If Value[I] = '''' Then Result := Result + '''';
        Result := Result + Value[I];
    End;
    Result := Result + '''';
End;

Function SP_Bounds(R : TCoordRect) : String;
Begin
    Result := '{"left":' + SP_MM(R.Left) + ',"bottom":' + SP_MM(R.Bottom) +
        ',"right":' + SP_MM(R.Right) + ',"top":' + SP_MM(R.Top) + '}';
End;

Function SP_IsPCB(Path : String) : Boolean;
Begin
    Result := UpperCase(ExtractFileExt(Path)) = '.PCBDOC';
End;

Procedure SP_ResolveBoard;
Var V : IServerDocumentView; D : TOpenDialog; Candidate : IPCB_Board; Path : String;
Begin
    If (Client = Nil) Or (PCBServer = Nil) Then SP_Fail('Altium PCB API is unavailable.');
    Path := ''; SP_Doc := Nil; V := Client.CurrentView;
    If V <> Nil Then
    Begin
        SP_Doc := V.OwnerDocument;
        If SP_Doc <> Nil Then If SP_IsPCB(SP_Doc.FileName) Then Path := SP_Doc.FileName;
    End;
    If Path = '' Then
    Begin
        SP_Doc := Client.LastActiveDocumentOfType('PCB');
        If SP_Doc <> Nil Then If SP_IsPCB(SP_Doc.FileName) Then Path := SP_Doc.FileName;
    End;
    If Path = '' Then
    Begin
        D := TOpenDialog.Create(Application);
        Try
            D.Title := 'SmartPCB 3.0 - select the board to process';
            D.Filter := 'Altium PCB (*.PcbDoc)|*.PcbDoc';
            D.Options := MkSet(ofFileMustExist, ofPathMustExist);
            If D.Execute = False Then SP_Fail('Cancelled.');
            Path := D.FileName;
        Finally D.Free; End;
    End;
    SP_Doc := Client.GetDocumentByPath(Path);
    If SP_Doc = Nil Then SP_Doc := Client.OpenDocument('PCB', Path);
    If SP_Doc = Nil Then SP_Fail('Cannot open PCB: ' + Path);
    Client.ShowDocument(SP_Doc); SP_Doc.Focus; Client.ApplicationIdle;
    Candidate := PCBServer.GetPCBBoardByPath(Path);
    If Candidate = Nil Then Candidate := PCBServer.GetCurrentPCBBoard;
    If Candidate = Nil Then SP_Fail('PCB server did not return the selected board.');
    If Not SP_IsPCB(Candidate.FileName) Then SP_Fail('Selected document is not a .PcbDoc.');
    If UpperCase(ExpandFileName(Candidate.FileName)) <> UpperCase(ExpandFileName(Path)) Then
        SP_Fail('PCB server returned a different document. No changes made.');
    SP_Board := Candidate; SP_OriginalPath := Path;
End;

Procedure SP_Init;
Begin
    SP_NetNames := TStringList.Create;
    SP_Protected := TStringList.Create;
    SP_Obstacles := TStringList.Create;
    SP_RawRules := TStringList.Create;
    SP_NetNames.CaseSensitive := True;
    SP_CCount := 0; SP_NCount := 0; SP_LCount := 0;
    SP_MoveCount := 0; SP_TrackCount := 0; SP_ViaCount := 0;
    SP_CopyPath := ''; SP_RunDir := '';
End;

Procedure SP_Free;
Begin
    If SP_NetNames <> Nil Then SP_NetNames.Free;
    If SP_Protected <> Nil Then SP_Protected.Free;
    If SP_Obstacles <> Nil Then SP_Obstacles.Free;
    If SP_RawRules <> Nil Then SP_RawRules.Free;
    SP_NetNames := Nil; SP_Protected := Nil; SP_Obstacles := Nil; SP_RawRules := Nil;
End;

Function SP_NetName(P : IPCB_Primitive) : String;
Begin
    Result := '';
    If P.Net <> Nil Then Result := P.Net.Name;
End;

Procedure SP_Protect(NetName, ReasonText : String);
Var I : Integer;
Begin
    If NetName = '' Then Exit;
    I := SP_NetNames.IndexOf(NetName);
    If I < 0 Then SP_Fail('An object references a net missing from the native net table.');
    If SP_Manual[I] = '' Then SP_Manual[I] := ReasonText;
    If SP_Protected.IndexOf(NetName) < 0 Then SP_Protected.Add(NetName);
End;

Function SP_LayerIndex(Value : TLayer) : Integer;
Var I : Integer;
Begin
    Result := -1;
    For I := 0 To SP_LCount - 1 Do If SP_Layer[I] = Value Then Result := I;
End;

Function SP_IsSignal(Value : TLayer) : Boolean;
Begin
    Result := (Value >= eTopLayer) And (Value <= eBottomLayer);
End;

Function SP_NetLayerScopeOnly(QueryText : String) : Boolean;
Var I : Integer; Token, C : String; Quoted : Boolean;
Begin
    { Width/via/layer rules may vary by net and layer, but the exchange cannot
      represent room/region/coordinate-dependent constraints. Ignore quoted
      net names when testing tokens so InNet('RX1') is handled correctly. }
    Result := True; I := 1; Quoted := False;
    While I <= Length(QueryText) Do
    Begin
        C := QueryText[I];
        If C = '''' Then Quoted := Not Quoted
        Else If Not Quoted Then
        Begin
            C := UpperCase(C);
            If ((C >= 'A') And (C <= 'Z')) Or (C = '_') Then
            Begin
                Token := '';
                While I <= Length(QueryText) Do
                Begin
                    C := UpperCase(QueryText[I]);
                    If Not (((C >= 'A') And (C <= 'Z')) Or ((C >= '0') And (C <= '9')) Or (C = '_')) Then Break;
                    Token := Token + C; I := I + 1;
                End;
                If (Token <> 'ALL') And (Token <> 'INNET') And (Token <> 'INNETCLASS') And
                   (Token <> 'ONLAYER') And (Token <> 'INLAYERCLASS') And (Token <> 'NET') And
                   (Token <> 'ISTRACK') And (Token <> 'ISARC') And (Token <> 'ISVIA') And
                   (Token <> 'AND') And (Token <> 'OR') And (Token <> 'NOT') And (Token <> 'XOR') And
                   (Token <> 'TRUE') And (Token <> 'FALSE') Then Begin Result := False; Exit; End;
                I := I - 1;
            End;
        End;
        I := I + 1;
    End;
    If Quoted Then Result := False;
End;

Procedure SP_Obstacle(P : IPCB_Primitive; AllSignalLayers : Boolean);
Var R : TCoordRect; S : String;
Begin
    R := P.BoundingRectangle;
    If (R.Right <= R.Left) Or (R.Top <= R.Bottom) Then Exit;
    S := '{"bounds":' + SP_Bounds(R);
    If Not AllSignalLayers Then
    Begin
        If SP_LayerIndex(P.Layer) < 0 Then Exit;
        S := S + ',"layers":[' + IntToStr(P.Layer) + ']';
    End;
    SP_Obstacles.Add(S + ',"reason":' + SP_JSON('Conservative obstacle: ' + P.ObjectIDString) + '}');
End;

Procedure SP_ReadTables;
Var It : IPCB_BoardIterator; L : IPCB_LayerObject; LS : IPCB_LayerStack;
    N : IPCB_Net; C : IPCB_Component; I : Integer;
Begin
    SP_NetNames.Clear; SP_Protected.Clear; SP_Obstacles.Clear; SP_RawRules.Clear;
    SP_CCount := 0; SP_NCount := 0; SP_LCount := 0; SP_HasPlanes := False;
    LS := SP_Board.LayerStack;
    If LS = Nil Then SP_Fail('No native layer stack.');
        For I := eTopLayer To eBottomLayer Do
    Begin
        L := LS.LayerObject[I];
        If L <> Nil Then
        Begin
            If L.IsInLayerStack <> False Then
            Begin
                If SP_LCount >= SP_MAX_LAYERS Then
                    SP_Fail('More than 8 signal layers are unsupported.');

                SP_Layer[SP_LCount] := L.LayerID;
                SP_LayerName[SP_LCount] := L.Name;
                SP_LCount := SP_LCount + 1;
            End;
        End;
    End;

    For I := eInternalPlane1 To eInternalPlane16 Do
    Begin
        L := LS.LayerObject[I];
        If L <> Nil Then
        Begin
            If L.IsInLayerStack <> False Then
                SP_HasPlanes := True;
        End;
    End;
    It := SP_Board.BoardIterator_Create;
    If It = Nil Then SP_Fail('Cannot create a net iterator.');
    Try
        It.AddFilter_ObjectSet(MkSet(eNetObject)); It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll); N := It.FirstPCBObject;
        While N <> Nil Do
        Begin
            If SP_NCount >= SP_MAX_NETS Then SP_Fail('Net limit is 8192.');
            If (N.Name = '') Or (SP_NetNames.IndexOf(N.Name) >= 0) Then SP_Fail('Invalid native net table.');
            SP_Net[SP_NCount] := N; SP_NetNames.Add(N.Name); SP_Manual[SP_NCount] := '';
            SP_NCount := SP_NCount + 1; N := It.NextPCBObject;
        End;
    Finally SP_Board.BoardIterator_Destroy(It); End;
    It := SP_Board.BoardIterator_Create;
    If It = Nil Then SP_Fail('Cannot create a component iterator.');
    Try
        It.AddFilter_ObjectSet(MkSet(eComponentObject)); It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll); C := It.FirstPCBObject;
        While C <> Nil Do
        Begin
            If SP_CCount >= SP_MAX_COMPONENTS Then SP_Fail('Component limit is 2048.');
            SP_Comp[SP_CCount] := C;
            SP_CompLocked[SP_CCount] := C.Moveable = False;
            SP_CCount := SP_CCount + 1; C := It.NextPCBObject;
        End;
    Finally SP_Board.BoardIterator_Destroy(It); End;
End;

Procedure SP_ReadRules;
Var It : IPCB_BoardIterator; R : IPCB_Rule; CR : IPCB_ClearanceConstraint;
    Probe, P : IPCB_Primitive; T : IPCB_Track; WR : IPCB_MaxMinWidthConstraint;
    LR : IPCB_RoutingLayersRule; VR : IPCB_RoutingViaStyleRule; PR : IPCB_RoutingPriorityRule;
    I, J, K : Integer; Q : String;
Begin
    SP_Clearance := -1; SP_SpatialWidth := False;
    It := SP_Board.BoardIterator_Create;
    If It = Nil Then SP_Fail('Cannot create a rule iterator.');
    Try
        It.AddFilter_ObjectSet(MkSet(eRuleObject)); It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll); R := It.FirstPCBObject;
        While R <> Nil Do
        Begin
            SP_RawRules.Add('{"name":' + SP_JSON(R.Name) + ',"kind":' + IntToStr(R.RuleKind) +
                ',"scope1":' + SP_JSON(R.Scope1Expression) + ',"scope2":' + SP_JSON(R.Scope2Expression) +
                ',"enabled":' + SP_Bool(R.DRCEnabled) + ',"priority":' + IntToStr(R.Priority) +
                ',"data":' + SP_JSON(R.GetState_DataSummaryString) + '}');
            If (R.DRCEnabled <> False) And (R.RuleKind = eRule_Clearance) Then
            Begin
                CR := R; If CoordToMMs(CR.Gap) > SP_Clearance Then SP_Clearance := CoordToMMs(CR.Gap);
            End;
            If (R.DRCEnabled <> False) And ((R.RuleKind = eRule_MaxMinWidth) Or (R.RuleKind = eRule_RoutingLayers) Or
               (R.RuleKind = eRule_RoutingViaStyle)) Then
            Begin
                If Not SP_NetLayerScopeOnly(R.Scope1Expression) Then SP_SpatialWidth := True;
            End;
            R := It.NextPCBObject;
        End;
    Finally SP_Board.BoardIterator_Destroy(It); End;
    If SP_Clearance < 0 Then SP_Fail('No enabled Clearance rule. Define rules before running.');
    Probe := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
    If Probe = Nil Then SP_Fail('Cannot create a temporary rule probe.');
    Try
        T := Probe; T.Board := SP_Board;
        For I := 0 To SP_NCount - 1 Do
        Begin
            T.Net := SP_Net[I]; T.Layer := SP_Layer[0];
            T.X1 := 0; T.Y1 := 0; T.X2 := 0; T.Y2 := 0;
            SP_ViaDiameter[I] := 0.6; SP_ViaHole[I] := 0.3; SP_Priority[I] := 0;
            R := SP_Board.FindDominantRuleForObject(T, eRule_RoutingViaStyle);
            If R = Nil Then SP_Protect(SP_NetNames[I], 'No native routing-via rule')
            Else
            Begin
                VR := R;
                SP_ViaDiameter[I] := CoordToMMs(VR.PreferedWidth);
                SP_ViaHole[I] := CoordToMMs(VR.PreferedHoleWidth);
                If VR.ViaStyle <> eViaThruHole Then SP_Protect(SP_NetNames[I], 'Via rule is not through-hole');
            End;
            R := SP_Board.FindDominantRuleForObject(T, eRule_RoutingPriority);
            If R <> Nil Then Begin PR := R; SP_Priority[I] := PR.RoutingPriority; End;
            If SP_SpatialWidth Then SP_Protect(SP_NetNames[I], 'Routing scopes beyond supported net/layer queries');
            { A default differential-pair rule can have scope All. It must not
              suppress ordinary nets: read actual native pair membership. }
            If SP_Net[I].InDifferentialPair <> False Then
                SP_Protect(SP_NetNames[I], 'Native differential-pair net needs manual routing');
            R := SP_Board.FindDominantRuleForObject(T, eRule_MatchedLengths);
            If R <> Nil Then If R.DRCEnabled Then SP_Protect(SP_NetNames[I], 'Matched-length rule is unsupported');
            R := SP_Board.FindDominantRuleForObject(T, eRule_MaxMinImpedance);
            If R <> Nil Then If R.DRCEnabled Then SP_Protect(SP_NetNames[I], 'Impedance constraints need manual routing');
            R := SP_Board.FindDominantRuleForObject(T, eRule_MaxMinLength);
            If R <> Nil Then If R.DRCEnabled Then SP_Protect(SP_NetNames[I], 'Track-length constraints need manual routing');
            R := SP_Board.FindDominantRuleForObject(T, eRule_FlightTime_RisingEdge);
            If R <> Nil Then If R.DRCEnabled Then SP_Protect(SP_NetNames[I], 'Timing constraints need manual routing');
            R := SP_Board.FindDominantRuleForObject(T, eRule_FlightTime_FallingEdge);
            If R <> Nil Then If R.DRCEnabled Then SP_Protect(SP_NetNames[I], 'Timing constraints need manual routing');
            For J := 0 To SP_LCount - 1 Do
            Begin
                K := I * SP_MAX_LAYERS + J; T.Layer := SP_Layer[J];
                SP_Allowed[K] := False; SP_Width[K] := 0.25; SP_MinWidth[K] := 0.25; SP_MaxWidth[K] := 0.25;
                R := SP_Board.FindDominantRuleForObject(T, eRule_RoutingLayers);
                If R <> Nil Then Begin LR := R; SP_Allowed[K] := LR.RoutingLayers[SP_Layer[J]] <> False; End;
                R := SP_Board.FindDominantRuleForObject(T, eRule_MaxMinWidth);
                If R = Nil Then SP_Protect(SP_NetNames[I], 'No native Width rule')
                Else
                Begin
                    WR := R;
                    SP_Width[K] := CoordToMMs(WR.FavoredWidth[SP_Layer[J]]);
                    SP_MinWidth[K] := CoordToMMs(WR.MinWidth[SP_Layer[J]]);
                    SP_MaxWidth[K] := CoordToMMs(WR.MaxWidth[SP_Layer[J]]);
                    If WR.ImpedanceDriven Then SP_Protect(SP_NetNames[I], 'Impedance-driven width is unsupported');
                    If (SP_Width[K] <= 0) Or (SP_Width[K] < SP_MinWidth[K]) Or (SP_Width[K] > SP_MaxWidth[K]) Then
                        SP_Fail('Invalid native Width values for net ' + SP_NetNames[I]);
                End;
            End;
            If (SP_ViaHole[I] <= 0) Or (SP_ViaDiameter[I] <= SP_ViaHole[I]) Then SP_Fail('Invalid native via sizes.');
        End;
    Finally
        Probe.Board := Nil; P := Probe; PCBServer.DestroyPCBObject(P);
    End;
End;

Function SP_PadJSON(Pad : IPCB_Pad; ComponentIndex : Integer) : String;
Var I, S, FirstShape : Integer;
    XSize, YSize, MaxX, MaxY, FirstX, FirstY : TCoord;
    CornerSize, FirstCorner, LayerCorner, HoleExtent : TCoord;
    Through, Exact : Boolean;
    ShapeText, ReasonText : String; R : TCoordRect;
Begin
    Through := Pad.Layer = eMultiLayer;
    Exact := True; ReasonText := ''; CornerSize := 0;
    R := Pad.BoundingRectangle;
    If Through Then
    Begin
        MaxX := 0; MaxY := 0; FirstX := 0; FirstY := 0;
        FirstShape := -1; FirstCorner := 0;
        For I := 0 To SP_LCount - 1 Do
        Begin
            XSize := Pad.GetState_XSizeOnLayer(SP_Layer[I]);
            YSize := Pad.GetState_YSizeOnLayer(SP_Layer[I]);
            S := Pad.GetState_ShapeOnLayer(SP_Layer[I]);
            LayerCorner := 0;
            If S = eRoundedRectangular Then
                LayerCorner := Pad.GetState_CornerRadiusOnLayer(SP_Layer[I]);
            If I = 0 Then
            Begin
                FirstX := XSize; FirstY := YSize;
                FirstShape := S; FirstCorner := LayerCorner;
            End;
            If (XSize <> FirstX) Or (YSize <> FirstY) Or
               (S <> FirstShape) Or (LayerCorner <> FirstCorner) Then Exact := False;
            If XSize > MaxX Then MaxX := XSize;
            If YSize > MaxY Then MaxY := YSize;
        End;
        XSize := MaxX; YSize := MaxY; S := FirstShape;
        CornerSize := FirstCorner;
        If Pad.Plated = False Then Exact := False;
        If Pad.HoleSize <= 0 Then Exact := False;
        If Pad.HoleType <> eRoundHole Then Exact := False;
        If Not Exact Then ReasonText := 'Nonuniform, unplated or unsupported multilayer pad';
    End
    Else
    Begin
        If SP_LayerIndex(Pad.Layer) < 0 Then
            SP_Fail('Pad is not on an exported signal layer.');
        XSize := Pad.GetState_XSizeOnLayer(Pad.Layer);
        YSize := Pad.GetState_YSizeOnLayer(Pad.Layer);
        S := Pad.GetState_ShapeOnLayer(Pad.Layer);
        If S = eRoundedRectangular Then
            CornerSize := Pad.GetState_CornerRadiusOnLayer(Pad.Layer);
        If Pad.HoleSize > 0 Then
        Begin Exact := False; ReasonText := 'Drilled single-layer pad'; End;
    End;
    If (XSize <= 0) Or (YSize <= 0) Then SP_Fail('Pad has invalid physical size.');
    If S = eRectangular Then ShapeText := 'rect'
    Else If (S = eRounded) Or ((S = eCircleShape) And (XSize = YSize)) Then
        ShapeText := 'round'
    Else If S = eRoundedRectangular Then
    Begin
        ShapeText := 'roundrect';
        If (CornerSize < 0) Or (2 * CornerSize > XSize) Or (2 * CornerSize > YSize) Then
        Begin Exact := False; ReasonText := 'Invalid rounded-rectangle corner radius'; End;
    End
    Else
    Begin Exact := False; ShapeText := 'rect'; ReasonText := 'Unsupported native pad shape'; End;
    If Pad.Mode <> ePadMode_Simple Then
    Begin Exact := False; ReasonText := 'Only Simple mode pads are supported by this adapter'; End;
    If Exact Then
    Begin
        { BoundingRectangle can include solder-mask expansion. Copper size comes
          from XSizeOnLayer/YSizeOnLayer, shape, rotation and corner radius.
          Use the general rectangle only to reject unsupported center offsets. }
        If (Abs((R.Left + R.Right) / 2 - Pad.X) > MMsToCoord(0.005)) Or
           (Abs((R.Bottom + R.Top) / 2 - Pad.Y) > MMsToCoord(0.005)) Then
        Begin Exact := False; ReasonText := 'Pad center/offset is unsupported by native adapter'; End;
    End;
    If Not Exact Then
    Begin
        If Pad.HoleSize > 0 Then
        Begin
            Through := True; HoleExtent := Pad.HoleSize;
            If Pad.HoleWidth > HoleExtent Then HoleExtent := Pad.HoleWidth;
            HoleExtent := Round(HoleExtent * 0.707106781186548) + 4;
            If Pad.X - HoleExtent < R.Left Then R.Left := Pad.X - HoleExtent;
            If Pad.X + HoleExtent > R.Right Then R.Right := Pad.X + HoleExtent;
            If Pad.Y - HoleExtent < R.Bottom Then R.Bottom := Pad.Y - HoleExtent;
            If Pad.Y + HoleExtent > R.Top Then R.Top := Pad.Y + HoleExtent;
        End;
        SP_Protect(SP_NetName(Pad), ReasonText);
        If ComponentIndex >= 0 Then SP_CompLocked[ComponentIndex] := True;
        Result := '{"id":' + SP_JSON(Pad.Name) + ',"net":' + SP_JSON(SP_NetName(Pad)) +
            ',"x":' + SP_MM((R.Left + R.Right) Div 2) + ',"y":' + SP_MM((R.Bottom + R.Top) Div 2) +
            ',"width":' + SP_MM(R.Right - R.Left) + ',"height":' + SP_MM(R.Top - R.Bottom) +
            ',"rotation":0,"shape":"rect","throughHole":' + SP_Bool(Through) +
            ',"layer":' + IntToStr(Pad.Layer) + ',"unsupportedGeometry":true}';
    End
    Else
        Result := '{"id":' + SP_JSON(Pad.Name) + ',"net":' + SP_JSON(SP_NetName(Pad)) +
            ',"x":' + SP_MM(Pad.X) + ',"y":' + SP_MM(Pad.Y) + ',"width":' + SP_MM(XSize) +
            ',"height":' + SP_MM(YSize) + ',"rotation":' + SP_Number(Pad.Rotation) +
            ',"shape":' + SP_JSON(ShapeText) + ',"cornerRadius":' + SP_MM(CornerSize) +
            ',"throughHole":' + SP_Bool(Through) + ',"layer":' + IntToStr(Pad.Layer) +
            ',"hole":' + SP_MM(Pad.HoleSize) + '}';
End;

Function SP_ComponentJSON(I : Integer) : String;
Var C : IPCB_Component; It : IPCB_GroupIterator; P : IPCB_Primitive; Pad : IPCB_Pad;
    Pads : TStringList; R : TCoordRect; J : Integer; CommentText, DesignatorText, S : String;
Begin
    C := SP_Comp[I]; R := C.BoundingRectangle; Pads := TStringList.Create;
    Try
        It := C.GroupIterator_Create;
        If It = Nil Then SP_Fail('Cannot read footprint primitives.');
        Try
            It.AddFilter_LayerSet(AllLayers);
            P := It.FirstPCBObject;
            While P <> Nil Do
            Begin
                If P.ObjectId = ePadObject Then Begin Pad := P; Pads.Add(SP_PadJSON(Pad, I)); End
                Else If SP_IsSignal(P.Layer) Or (P.Layer = eMultiLayer) Or (P.Layer = eKeepOutLayer) Or P.IsKeepout Then
                Begin
                    SP_CompLocked[I] := True;
                    SP_Obstacle(P, (P.Layer = eMultiLayer) Or (P.Layer = eKeepOutLayer));
                    SP_Protect(SP_NetName(P), 'Footprint copper outside the supported pad model');
                End;
                P := It.NextPCBObject;
            End;
        Finally C.GroupIterator_Destroy(It); End;
        CommentText := ''; If C.Comment <> Nil Then CommentText := C.Comment.Text;
        DesignatorText := ''; If C.Name <> Nil Then DesignatorText := C.Name.Text;
        If DesignatorText = '' Then DesignatorText := C.SourceDesignator;
        If DesignatorText = '' Then DesignatorText := '@COMP_' + IntToStr(I);
        S := '{"id":' + SP_JSON(DesignatorText) + ',"index":' + IntToStr(I) +
            ',"x":' + SP_MM(C.X) + ',"y":' + SP_MM(C.Y) + ',"rotation":' + SP_Number(C.Rotation) +
            ',"layer":' + IntToStr(C.Layer) + ',"locked":' + SP_Bool(SP_CompLocked[I]) +
            ',"bounds":' + SP_Bounds(R) + ',"comment":' + SP_JSON(CommentText) + ',"pads":[';
        For J := 0 To Pads.Count - 1 Do Begin If J > 0 Then S := S + ','; S := S + Pads[J]; End;
        Result := S + ']}';
    Finally Pads.Free; End;
End;

Procedure SP_Export(Lines : TStringList);
Var I, J, K, FreePads : Integer; It : IPCB_BoardIterator; P : IPCB_Primitive;
    T : IPCB_Track; V : IPCB_Via; Pad : IPCB_Pad; O : IPCB_BoardOutline; Seg : TPolySegment;
    Components, Tracks, Vias : TStringList; S, NetText : String; R : TCoordRect; SimpleVia : Boolean;
    Reg : IPCB_Region;
Begin
    Lines.Clear; SP_ReadTables; SP_ReadRules;
    Components := TStringList.Create; Tracks := TStringList.Create; Vias := TStringList.Create;
    Try
        For I := 0 To SP_CCount - 1 Do Components.Add(SP_ComponentJSON(I));
        FreePads := 0;
        It := SP_Board.BoardIterator_Create;
        If It = Nil Then SP_Fail('Cannot read PCB primitives.');
        Try
            It.AddFilter_ObjectSet(MkSet(ePadObject, eTrackObject, eViaObject, eArcObject,
                eFillObject, eRegionObject, ePolyObject, eTextObject));
            It.AddFilter_LayerSet(AllLayers); It.AddFilter_Method(eProcessAll);
            P := It.FirstPCBObject;
            While P <> Nil Do
            Begin
                If (P.Component = Nil) And (P.ObjectId <> eComponentObject) And
                   (P.ViewableObjectID <> eViewableObject_BoardRegion) Then
                Begin
                    NetText := SP_NetName(P);
                    If (P.Layer = eKeepOutLayer) Or P.IsKeepout Then SP_Obstacle(P, (P.Layer = eKeepOutLayer) Or (P.Layer = eMultiLayer))
                    Else If P.ObjectId = ePadObject Then
                    Begin
                        Pad := P; R := P.BoundingRectangle;
                        Components.Add('{"id":' + SP_JSON('@FREEPAD_' + IntToStr(FreePads)) +
                            ',"index":' + IntToStr(SP_MAX_COMPONENTS + FreePads) + ',"x":' + SP_MM(Pad.X) +
                            ',"y":' + SP_MM(Pad.Y) + ',"rotation":0,"locked":true,"bounds":' + SP_Bounds(R) +
                            ',"pads":[' + SP_PadJSON(Pad, -1) + ']}'); FreePads := FreePads + 1;
                    End
                    Else If (P.ObjectId = eTrackObject) And (SP_LayerIndex(P.Layer) >= 0) Then
                    Begin
                        T := P;
                        Tracks.Add('{"net":' + SP_JSON(NetText) + ',"layer":' + IntToStr(T.Layer) +
                            ',"x1":' + SP_MM(T.X1) + ',"y1":' + SP_MM(T.Y1) + ',"x2":' + SP_MM(T.X2) +
                            ',"y2":' + SP_MM(T.Y2) + ',"width":' + SP_MM(T.Width) + '}');
                    End
                    Else If P.ObjectId = eViaObject Then
                    Begin
                        V := P;
                        SimpleVia := True;
                        For J := 0 To SP_LCount - 1 Do
                            If V.GetState_SizeOnLayer(SP_Layer[J]) <> V.Size Then SimpleVia := False;
                        If ((V.LowLayer = eTopLayer) And (V.HighLayer = eBottomLayer)) Or
                           ((V.HighLayer = eTopLayer) And (V.LowLayer = eBottomLayer)) Then
                        Begin
                            If SimpleVia Then
                            Vias.Add('{"net":' + SP_JSON(NetText) + ',"x":' + SP_MM(V.X) + ',"y":' + SP_MM(V.Y) +
                                ',"diameter":' + SP_MM(V.Size) + ',"hole":' + SP_MM(V.HoleSize) +
                                ',"fromLayer":' + IntToStr(SP_Layer[0]) + ',"toLayer":' + IntToStr(SP_Layer[SP_LCount - 1]) + '}')
                            Else Begin SP_Obstacle(P, True); SP_Protect(NetText, 'Existing via has nonuniform stack geometry'); End;
                        End
                        Else Begin SP_Obstacle(P, True); SP_Protect(NetText, 'Existing blind or buried via'); End;
                    End
                    Else If P.ObjectId = eRegionObject Then
                    Begin
                        Reg := P;
                        If (Reg.Kind = eRegionKind_BoardCutout) Or (Reg.Kind = eRegionKind_Cavity) Then
                            SP_Obstacle(P, True)
                        Else If Reg.Kind = eRegionKind_Copper Then
                        Begin
                            If SP_IsSignal(P.Layer) Or (P.Layer = eMultiLayer) Then
                            Begin
                                SP_Obstacle(P, P.Layer = eMultiLayer);
                                SP_Protect(NetText, 'Existing copper region');
                            End;
                        End
                        Else If (Reg.Kind = eRegionKind_NamedRegion) Or (Reg.Kind = eRegionKind_Cutout) Then
                        Begin
                            { Board definition and polygon exclusions are not copper obstacles. }
                        End
                        Else SP_Fail('Unsupported native region kind.');
                    End
                    Else If (P.ObjectId = ePolyObject) Or (P.ObjectId = eFillObject) Or
                            (P.ObjectId = eArcObject) Or (P.ObjectId = eTextObject) Then
                    Begin
                        If SP_IsSignal(P.Layer) Or (P.Layer = eMultiLayer) Then
                        Begin
                            SP_Obstacle(P, P.Layer = eMultiLayer);
                            SP_Protect(NetText, 'Existing arc, polygon, fill or copper text');
                        End;
                    End;
                End;
                P := It.NextPCBObject;
            End;
        Finally SP_Board.BoardIterator_Destroy(It); End;
        If Components.Count > SP_MAX_COMPONENTS Then SP_Fail('Components including free pads exceed 2048.');
        Lines.Add('{"schemaVersion":3,"tool":"SmartPCB 3.0","sourcePath":' + SP_JSON(SP_Board.FileName) +
            ',"settings":{"mode":' + SP_JSON(SP_Mode) + '},"throughViaLow":' + IntToStr(eTopLayer) +
            ',"throughViaHigh":' + IntToStr(eBottomLayer) + ',"hasInternalPlanes":' + SP_Bool(SP_HasPlanes) + ',"outlineSegments":[');
        O := SP_Board.BoardOutline;
        If O = Nil Then SP_Fail('Native board outline is unavailable.');
        If O.PointCount < 3 Then SP_Fail('Native board outline has fewer than 3 points.');
        For I := 0 To O.PointCount - 1 Do
        Begin
            Seg := O.GetState_Segments(I); S := '';
            If I > 0 Then S := ',';
            S := S + '{"x":' + SP_MM(Seg.vx) + ',"y":' + SP_MM(Seg.vy);
            If Seg.Kind = ePolySegmentLine Then S := S + ',"kind":"line"}'
            Else If Seg.Kind = ePolySegmentArc Then S := S + ',"kind":"arc","cx":' + SP_MM(Seg.cx) +
                ',"cy":' + SP_MM(Seg.cy) + ',"radius":' + SP_MM(Seg.Radius) +
                ',"angle1":' + SP_Number(Seg.Angle1) + ',"angle2":' + SP_Number(Seg.Angle2) + '}'
            Else SP_Fail('Unsupported native board outline segment.');
            Lines.Add(S);
        End;
        Lines.Add('],"layers":[');
        For I := 0 To SP_LCount - 1 Do
        Begin
            S := ''; If I > 0 Then S := ',';
            Lines.Add(S + '{"id":' + IntToStr(SP_Layer[I]) + ',"name":' + SP_JSON(SP_LayerName[I]) + ',"type":"signal"}');
        End;
        Lines.Add('],"netNames":[');
        For I := 0 To SP_NCount - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + SP_JSON(SP_NetNames[I])); End;
        Lines.Add('],"components":[');
        For I := 0 To Components.Count - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + Components[I]); End;
        Lines.Add('],"tracks":[');
        For I := 0 To Tracks.Count - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + Tracks[I]); End;
        Lines.Add('],"vias":[');
        For I := 0 To Vias.Count - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + Vias[I]); End;
        Lines.Add('],"keepouts":[');
        For I := 0 To SP_Obstacles.Count - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + SP_Obstacles[I]); End;
        Lines.Add('],"cutouts":[],"protectedNets":[');
        For I := 0 To SP_Protected.Count - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + SP_JSON(SP_Protected[I])); End;
        Lines.Add('],"rawRules":[');
        For I := 0 To SP_RawRules.Count - 1 Do Begin S := ''; If I > 0 Then S := ','; Lines.Add(S + SP_RawRules[I]); End;
        Lines.Add('],"rules":{"default":{"width":0.25,"clearance":' + SP_Number(SP_Clearance) +
            ',"viaDiameter":0.6,"viaHole":0.3},"nets":{');
        For I := 0 To SP_NCount - 1 Do
        Begin
            S := ''; If I > 0 Then S := ',';
            S := S + SP_JSON(SP_NetNames[I]) + ':{"clearance":' + SP_Number(SP_Clearance) +
                ',"viaDiameter":' + SP_Number(SP_ViaDiameter[I]) + ',"viaHole":' + SP_Number(SP_ViaHole[I]) +
                ',"priority":' + SP_Number(SP_Priority[I]) + ',"allowVias":' + SP_Bool(Not SP_HasPlanes) +
                ',"unsupportedReason":' + SP_JSON(SP_Manual[I]) + ',"layers":{';
            For J := 0 To SP_LCount - 1 Do
            Begin
                K := I * SP_MAX_LAYERS + J; If J > 0 Then S := S + ',';
                S := S + SP_JSON(IntToStr(SP_Layer[J])) + ':{"allowed":' + SP_Bool(SP_Allowed[K]) +
                    ',"width":' + SP_Number(SP_Width[K]) + ',"minWidth":' + SP_Number(SP_MinWidth[K]) +
                    ',"maxWidth":' + SP_Number(SP_MaxWidth[K]) + '}';
            End;
            Lines.Add(S + '}}');
        End;
        Lines.Add('}}}');
    Finally Components.Free; Tracks.Free; Vias.Free; End;
End;

Function SP_Double(S : String) : Double;
Var I, Sign, Digits : Integer; Frac, Scale : Double; DotSeen : Boolean;
Begin
    If S = '' Then SP_Fail('Empty numeric import field.');
    Result := 0; Frac := 0; Scale := 1; Sign := 1; DotSeen := False; Digits := 0;
    I := 1; If S[1] = '-' Then Begin Sign := -1; I := 2; End;
    While I <= Length(S) Do
    Begin
        If S[I] = '.' Then
        Begin If DotSeen Then SP_Fail('Invalid decimal import field.'); DotSeen := True; End
        Else
        Begin
            If (S[I] < '0') Or (S[I] > '9') Then SP_Fail('Nonnumeric import field.');
            Digits := Digits + 1;
            If DotSeen Then Begin Scale := Scale * 10; Frac := Frac + (Ord(S[I]) - 48) / Scale; End
            Else Result := Result * 10 + Ord(S[I]) - 48;
        End;
        If Result > 1000000000 Then SP_Fail('Import number is outside its permitted range.');
        I := I + 1;
    End;
    If Digits = 0 Then SP_Fail('Missing decimal digits.');
    Result := Sign * (Result + Frac);
End;

Function SP_Int(S : String) : Integer;
Var D : Double;
Begin
    D := SP_Double(S);
    If (D < 0) Or (D > SP_MAX_PLAN_OBJECTS) Or (D <> Trunc(D)) Then SP_Fail('Invalid import integer.');
    Result := Trunc(D);
End;

Function SP_Coord(S : String) : TCoord;
Var D : Double;
Begin
    D := SP_Double(S);
    If (D < 0) Or (D > CoordToMMs(SP_MAX_COORD)) Then SP_Fail('Import coordinate is outside AD16 limits.');
    Result := MMsToCoord(D);
End;

Procedure SP_Fields(LineText : String; F : TStringList);
Var I, Start : Integer;
Begin
    F.Clear; Start := 1;
    For I := 1 To Length(LineText) Do If LineText[I] = #9 Then
    Begin F.Add(Copy(LineText, Start, I - Start)); Start := I + 1; End;
    F.Add(Copy(LineText, Start, Length(LineText) - Start + 1));
End;

Procedure SP_Preflight(Plan : TStringList);
Var F, Seen : TStringList; I, NI, CI, LI, K, MC, TC, VC, Phase : Integer;
    X, Y, DX, DY, W, D, H : Double; C : IPCB_Component; R : TCoordRect;
    X1, Y1, X2, Y2 : TCoord;
Begin
    If (Plan.Count < 2) Or (Plan.Count > SP_MAX_PLAN_OBJECTS + 2) Then SP_Fail('Invalid plan row count.');
    F := TStringList.Create; Seen := TStringList.Create;
    Try
        SP_Fields(Plan[0], F);
        If F.Count <> 5 Then SP_Fail('Invalid import header.');
        If (F[0] <> 'SMARTPCB') Or (F[1] <> '3') Then SP_Fail('Unsupported import schema.');
        SP_MoveCount := SP_Int(F[2]); SP_TrackCount := SP_Int(F[3]); SP_ViaCount := SP_Int(F[4]);
        If Plan.Count <> SP_MoveCount + SP_TrackCount + SP_ViaCount + 2 Then SP_Fail('Plan header counts disagree.');
        MC := 0; TC := 0; VC := 0; Phase := 0;
        For I := 1 To Plan.Count - 2 Do
        Begin
            SP_Fields(Plan[I], F);
            If F.Count <> 8 Then SP_Fail('Invalid import field count.');
            If F[0] = 'COMP' Then
            Begin
                If Phase > 0 Then SP_Fail('Component rows must precede copper.');
                CI := SP_Int(F[1]); If CI >= SP_CCount Then SP_Fail('Unknown native component index.');
                If Seen.IndexOf(F[1]) >= 0 Then SP_Fail('Duplicate component move.'); Seen.Add(F[1]);
                C := SP_Comp[CI]; If SP_CompLocked[CI] Or (C.Moveable = False) Then SP_Fail('Plan tries to move a locked component.');
                If (Abs(CoordToMMs(C.X) - SP_Double(F[2])) > 0.00001) Or
                   (Abs(CoordToMMs(C.Y) - SP_Double(F[3])) > 0.00001) Or
                   (Abs(C.Rotation - SP_Double(F[4])) > 0.00001) Then SP_Fail('Component position changed since export.');
                If Abs(SP_Double(F[7]) - C.Rotation) > 0.00001 Then SP_Fail('Planned rotations are unsupported.');
                X := CoordToMMs(SP_Coord(F[5])); Y := CoordToMMs(SP_Coord(F[6]));
                DX := X - CoordToMMs(C.X); DY := Y - CoordToMMs(C.Y); R := C.BoundingRectangle;
                If (CoordToMMs(R.Left) + DX < 0) Or (CoordToMMs(R.Bottom) + DY < 0) Or
                   (CoordToMMs(R.Right) + DX > CoordToMMs(SP_MAX_COORD)) Or
                   (CoordToMMs(R.Top) + DY > CoordToMMs(SP_MAX_COORD)) Then SP_Fail('Moved footprint exceeds AD16 coordinate limits.');
                MC := MC + 1;
            End
            Else If F[0] = 'TRACK' Then
            Begin
                If Phase > 1 Then SP_Fail('Track rows must precede vias.'); Phase := 1;
                NI := SP_Int(F[1]); If NI >= SP_NCount Then SP_Fail('Unknown native track net.');
                If SP_Manual[NI] <> '' Then SP_Fail('Plan adds copper to an unsupported protected net.');
                LI := SP_LayerIndex(SP_Int(F[2])); If LI < 0 Then SP_Fail('Track uses a layer outside the native stack.');
                K := NI * SP_MAX_LAYERS + LI;
                If Not SP_Allowed[K] Then SP_Fail('Track violates the native routing-layer rule.');
                W := SP_Double(F[3]);
                If Abs(W - SP_Width[K]) > 0.00001 Then SP_Fail('Track does not use native Preferred Width.');
                If (W < SP_MinWidth[K] - 0.00001) Or (W > SP_MaxWidth[K] + 0.00001) Or (W <= 0) Then SP_Fail('Invalid track width.');
                X1 := SP_Coord(F[4]); Y1 := SP_Coord(F[5]); X2 := SP_Coord(F[6]); Y2 := SP_Coord(F[7]);
                If (X1 = X2) And (Y1 = Y2) Then SP_Fail('Track collapses to zero length in native coordinates.'); TC := TC + 1;
            End
            Else If F[0] = 'VIA' Then
            Begin
                Phase := 2; NI := SP_Int(F[1]); If NI >= SP_NCount Then SP_Fail('Unknown native via net.');
                If (SP_Manual[NI] <> '') Or SP_HasPlanes Then SP_Fail('Via is unsupported for this board/net.');
                SP_Coord(F[2]); SP_Coord(F[3]); D := SP_Double(F[4]); H := SP_Double(F[5]);
                If (D <= H) Or (H <= 0) Or (Abs(D - SP_ViaDiameter[NI]) > 0.00001) Or
                   (Abs(H - SP_ViaHole[NI]) > 0.00001) Then SP_Fail('Via does not match the native via rule.');
                If (SP_Int(F[6]) <> eTopLayer) Or (SP_Int(F[7]) <> eBottomLayer) Then SP_Fail('Only physical through-vias are permitted.');
                VC := VC + 1;
            End
            Else SP_Fail('Unknown import row type.');
        End;
        SP_Fields(Plan[Plan.Count - 1], F);
        If (F.Count <> 4) Or (F[0] <> 'END') Then SP_Fail('Import plan is incomplete.');
        If (MC <> SP_MoveCount) Or (TC <> SP_TrackCount) Or (VC <> SP_ViaCount) Then SP_Fail('Import row counts disagree.');
        If SP_Int(F[1]) > SP_Int(F[2]) Then SP_Fail('Invalid routing-completion counts.');
        If (SP_Double(F[3]) < 0) Or (SP_Double(F[3]) > 100) Then SP_Fail('Invalid completion percentage.');
    Finally F.Free; Seen.Free; End;
End;

Procedure SP_Apply(Plan : TStringList);
Var F : TStringList; P : IPCB_Primitive; T : IPCB_Track; V : IPCB_Via;
    I, CI, NI, Added, Moved, CreatedCount : Integer; C : IPCB_Component; Applied : Boolean;
    MoveIndices : Array[0..2047] Of Integer; OldX, OldY : Array[0..2047] Of TCoord;
Begin
    F := TStringList.Create; Added := 0; Moved := 0; CreatedCount := 0; Applied := False;
    Try
        { Allocate/configure every new object before touching the PCB. }
        For I := 1 + SP_MoveCount To Plan.Count - 2 Do
        Begin
            SP_Fields(Plan[I], F); NI := SP_Int(F[1]);
            If F[0] = 'TRACK' Then
            Begin
                P := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
                If P = Nil Then SP_Fail('Cannot allocate new PCB track.');
                SP_NewObjects[CreatedCount] := P; CreatedCount := CreatedCount + 1;
                T := P; T.Net := SP_Net[NI]; T.Layer := SP_Int(F[2]);
                T.Width := MMsToCoord(SP_Double(F[3])); T.X1 := SP_Coord(F[4]); T.Y1 := SP_Coord(F[5]);
                T.X2 := SP_Coord(F[6]); T.Y2 := SP_Coord(F[7]);
            End
            Else
            Begin
                P := PCBServer.PCBObjectFactory(eViaObject, eNoDimension, eCreate_Default);
                If P = Nil Then SP_Fail('Cannot allocate new PCB via.');
                SP_NewObjects[CreatedCount] := P; CreatedCount := CreatedCount + 1;
                V := P; V.Net := SP_Net[NI]; V.X := SP_Coord(F[2]); V.Y := SP_Coord(F[3]);
                V.Size := MMsToCoord(SP_Double(F[4])); V.HoleSize := MMsToCoord(SP_Double(F[5]));
                V.LowLayer := eTopLayer; V.HighLayer := eBottomLayer;
            End;
        End;
        PCBServer.PreProcess;
        Try
            Try
                For I := 1 To SP_MoveCount Do
                Begin
                    SP_Fields(Plan[I], F); CI := SP_Int(F[1]); C := SP_Comp[CI];
                    MoveIndices[Moved] := CI; OldX[Moved] := C.X; OldY[Moved] := C.Y; Moved := Moved + 1;
                    PCBServer.SendMessageToRobots(C.I_ObjectAddress, c_Broadcast, PCBM_BeginModify, c_NoEventData);
                    Try C.MoveByXY(SP_Coord(F[5]) - C.X, SP_Coord(F[6]) - C.Y);
                    Finally PCBServer.SendMessageToRobots(C.I_ObjectAddress, c_Broadcast, PCBM_EndModify, c_NoEventData); End;
                End;
                For I := 0 To CreatedCount - 1 Do
                Begin
                    P := SP_NewObjects[I]; SP_Board.AddPCBObject(P); Added := Added + 1;
                    PCBServer.SendMessageToRobots(SP_Board.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, P.I_ObjectAddress);
                End;
                Applied := True;
            Except
                { Roll back only changes made in this transaction. }
                For I := Added - 1 DownTo 0 Do
                Begin
                    P := SP_NewObjects[I]; SP_Board.RemovePCBObject(P);
                    PCBServer.SendMessageToRobots(SP_Board.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, P.I_ObjectAddress);
                End;
                For I := Moved - 1 DownTo 0 Do
                Begin
                    C := SP_Comp[MoveIndices[I]];
                    PCBServer.SendMessageToRobots(C.I_ObjectAddress, c_Broadcast, PCBM_BeginModify, c_NoEventData);
                    Try C.MoveByXY(OldX[I] - C.X, OldY[I] - C.Y);
                    Finally PCBServer.SendMessageToRobots(C.I_ObjectAddress, c_Broadcast, PCBM_EndModify, c_NoEventData); End;
                End;
                Raise;
            End;
        Finally PCBServer.PostProcess; End;
        SP_Doc.Modified := True; SP_Board.ViewManager_FullUpdate;
        Client.SendMessage('PCB:Zoom', 'Action=Redraw', 255, Client.CurrentView);
    Finally
        For I := 0 To CreatedCount - 1 Do
        Begin
            If Not Applied Then Begin P := SP_NewObjects[I]; PCBServer.DestroyPCBObject(P); End;
            SP_NewObjects[I] := Nil;
        End;
        F.Free;
    End;
End;

Procedure SP_FindEngine;
Var D : TOpenDialog;
Begin
    SP_EngineDir := ExtractFilePath(GetRunningScriptProjectName);
    If FileExists(SP_EngineDir + 'smartpcb.js') = False Then SP_EngineDir := SP_FALLBACK_FOLDER + '\';
    If FileExists(SP_EngineDir + 'smartpcb.js') = False Then
    Begin
        D := TOpenDialog.Create(Application);
        Try
            D.Title := 'SmartPCB - select smartpcb.js in the extracted tool folder';
            D.Filter := 'SmartPCB engine (smartpcb.js)|smartpcb.js';
            D.Options := MkSet(ofFileMustExist, ofPathMustExist);
            If D.Execute = False Then SP_Fail('Cancelled.'); SP_EngineDir := ExtractFilePath(D.FileName);
        Finally D.Free; End;
    End;
    If FileExists(SP_EngineDir + 'router.js') = False Then SP_Fail('router.js is missing from the tool folder.');
    If FileExists(SP_EngineDir + 'placer.js') = False Then SP_Fail('placer.js is missing from the tool folder.');
    If FileExists(SP_EngineDir + 'config.json') = False Then SP_Fail('config.json is missing from the tool folder.');
    SP_NodePath := SP_DEFAULT_NODE;
    If FileExists(SP_NodePath) = False Then SP_NodePath := 'C:\Program Files\nodejs\node.exe';
    If FileExists(SP_NodePath) = False Then
    Begin
        D := TOpenDialog.Create(Application);
        Try
            D.Title := 'SmartPCB - select Node.js node.exe';
            D.Filter := 'Node.js executable (node.exe)|node.exe';
            D.Options := MkSet(ofFileMustExist, ofPathMustExist);
            If D.Execute = False Then SP_Fail('Node.js selection cancelled.'); SP_NodePath := D.FileName;
        Finally D.Free; End;
    End;
End;

Procedure SP_RunEngine;
Var CommandLine, CodeLine, DonePath, ErrorPath : String; Code : Integer; StartTime : TDateTime; Status : TStringList;
Begin
    { The local WSH host can be disabled by policy. Use the installed Windows
      PowerShell executable, hidden, with a literal single-quoted argument for
      every path. No downloaded scripts or policy overrides are involved. }
    DonePath := SP_RunDir + '\done.txt'; ErrorPath := SP_RunDir + '\error.txt';
    CodeLine := 'try { & ' + SP_PSQuote(SP_NodePath) + ' ' + SP_PSQuote(SP_EngineDir + 'smartpcb.js') +
        ' ' + SP_PSQuote(SP_RunDir + '\input.json') + ' ' + SP_PSQuote(SP_RunDir) +
        ' ' + SP_PSQuote(SP_EngineDir + 'config.json') +
        '; if (-not [IO.File]::Exists(' + SP_PSQuote(DonePath) +
        ')) { throw ''Solver exited without a completion file.'' } } catch { [IO.File]::WriteAllText(' +
        SP_PSQuote(ErrorPath) + ', $_.Exception.Message); [IO.File]::WriteAllText(' +
        SP_PSQuote(DonePath) + ', ''ERROR'' + [Environment]::NewLine + $_.Exception.Message) }';
    CommandLine := 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + CodeLine + '"';
    Code := RunApplication(CommandLine);
    If Code <> 0 Then SP_Fail('Cannot launch solver: ' + GetErrorMessage(Code));
    StartTime := Now;
    While FileExists(SP_RunDir + '\done.txt') = False Do
    Begin
        Client.ApplicationIdle;
        If (Now - StartTime) * 86400 > SP_TIMEOUT_SECONDS Then
            SP_Fail('Solver time limit reached. Nothing was imported. See the run folder.');
    End;
    Status := TStringList.Create;
    Try
        Status.LoadFromFile(SP_RunDir + '\done.txt');
        If Status.Count = 0 Then SP_Fail('Empty solver completion file. Nothing imported.');
        If Status[0] <> 'OK' Then SP_Fail('Solver rejected the plan. Read error.txt in ' + SP_RunDir);
    Finally Status.Free; End;
End;

Procedure SP_Execute(ModeText : String; ApplyPlan : Boolean);
Var BeforeState, AfterState, Plan : TStringList; Stamp, OriginalJSON, CopyBase : String;
   RunIndex : Integer;
Current : IPCB_Board;
Begin
    If SP_Busy = True Then Begin ShowMessage('A SmartPCB operation is already running.'); Exit; End;
    SP_Busy := True;
    SP_NetNames := Nil; SP_Protected := Nil; SP_Obstacles := Nil; SP_RawRules := Nil;
    SP_Init; BeforeState := TStringList.Create; AfterState := TStringList.Create; Plan := TStringList.Create;
    Try
        Try
            SP_Mode := ModeText; SP_ResolveBoard; SP_FindEngine;
            Stamp := FormatDateTime('yyyymmdd_hhnnss', Now);
            SP_RunDir := SP_EngineDir + 'runtime\' + Stamp; RunIndex := 0;
            While DirectoryExists(SP_RunDir) Do Begin RunIndex := RunIndex + 1; SP_RunDir := SP_EngineDir + 'runtime\' + Stamp + '_' + IntToStr(RunIndex); End;
            If ForceDirectories(SP_RunDir) = False Then SP_Fail('Cannot create the SmartPCB run directory.');
            If ApplyPlan Then
            Begin
                CopyBase := SP_RunDir + '\' + ChangeFileExt(ExtractFileName(SP_OriginalPath), '') + '_SmartPCB';
                SP_CopyPath := CopyBase + '.PcbDoc'; RunIndex := 0;
                While FileExists(SP_CopyPath) Do Begin RunIndex := RunIndex + 1; SP_CopyPath := CopyBase + '_' + IntToStr(RunIndex) + '.PcbDoc'; End;
                If SP_Doc.DoSafeChangeFileNameAndSave(SP_CopyPath, 'PCB Binary') = False Then
                    SP_Fail('Could not save a working copy. No PCB objects changed.');
                If FileExists(SP_CopyPath) = False Then SP_Fail('Working copy was not created. No PCB objects changed.');
                Current := PCBServer.GetPCBBoardByPath(SP_CopyPath);
                If Current = Nil Then SP_Fail('Cannot read the saved working copy. No PCB objects changed.');
                SP_Board := Current; SP_Doc := Client.GetDocumentByPath(SP_CopyPath);
                If SP_Doc = Nil Then SP_Fail('Working copy has no native document handle.');
            End;
            SP_Export(BeforeState); OriginalJSON := BeforeState.Text;
            BeforeState.SaveToFile(SP_RunDir + '\input.json');
            SP_RunEngine;
            If ApplyPlan Then
            Begin
                If UpperCase(SP_Doc.FileName) <> UpperCase(SP_CopyPath) Then SP_Fail('Target document changed during solving.');
                SP_Export(AfterState);
                If OriginalJSON <> AfterState.Text Then SP_Fail('Board geometry or rules changed during solving. Plan was not imported.');
                Plan.LoadFromFile(SP_RunDir + '\import.tsv'); SP_Preflight(Plan);
                Client.ShowDocument(SP_Doc); SP_Doc.Focus;
                SP_Apply(Plan);
                If SP_Doc.DoSafeFileSave('PCB Binary') = False Then
                    SP_Fail('Changes are in the working copy but automatic save failed. Save the copy manually.');
            End;
            RunApplication('explorer.exe "' + SP_RunDir + '\report.html"');
            If ApplyPlan Then ShowMessage('SmartPCB 3.0 finished.' + #13#10 +
                'Moved components: ' + IntToStr(SP_MoveCount) + #13#10 + 'New tracks: ' + IntToStr(SP_TrackCount) +
                #13#10 + 'New vias: ' + IntToStr(SP_ViaCount) + #13#10 + 'Working copy: ' + SP_CopyPath +
                #13#10 + 'Run Altium DRC. See report.html for routes requiring manual work.')
            Else ShowMessage('SmartPCB 3.0 preview finished. No PCB objects changed.' + #13#10 +
                'Preview report: ' + SP_RunDir + '\report.html');
        Except
            ShowMessage('SmartPCB 3.0 stopped.' + #13#10 + ExceptionMessage + #13#10 +
                'Original file on disk was not overwritten.' + #13#10 + 'Run folder: ' + SP_RunDir);
        End;
    Finally BeforeState.Free; AfterState.Free; Plan.Free; SP_Free; SP_Busy := False; End;
End;

Procedure SmartAuto;
Begin
    SP_Execute('place-and-route', True);
End;

Procedure SmartRouteOnly;
Begin
    SP_Execute('route-only', True);
End;

Procedure PreviewSmart;
Begin
    SP_Execute('place-and-route', False);
End;
